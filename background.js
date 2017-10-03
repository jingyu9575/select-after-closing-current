let settings = {}

async function reloadSettings() {
	settings = await browser.storage.local.get()
	settings.commandOrder = settings.commandOrder || []
	settings.version = settings.version || 0
	if (typeof settings.commandOrder[0] === 'string') settings.version = 1

	const needMigrate = !settings.version || settings.version < 2
	if (needMigrate) {
		if (settings.version < 1 && !settings.commandOrder.length) {
			settings.version = 1
			settings.commandOrder = ['lastAccessed', 'left', 'right']
		}
		if (settings.version < 2) {
			settings.version = 2
			settings.commandOrder = settings.commandOrder.map(value =>
				typeof value === 'string' ? {
					lastAccessed: { position: 'first', relation: 'lastAccessed' },
					left: { position: 'left', relation: 'none' },
					right: { position: 'right', relation: 'none' },
					opener: { position: 'first', relation: 'parent' },
				}[value] : value)
		}
		await browser.storage.local.set(settings)
	}
}

browser.runtime.onMessage.addListener(async message => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'reloadSettings') {
		await reloadSettings()
		return settings
	}
})

class Tracker {
	constructor(windowId) {
		this.windowId = windowId
		this.activeIndex = undefined
		this.activeOpener = undefined
		this.activeIds = []

		this.freeze(false)
	}

	removeActiveId(tabId) {
		const i = this.activeIds.indexOf(tabId)
		if (i > -1) this.activeIds.splice(i, 1)
	}

	async remove(tabId) {
		try {
			if (this.activeIds[this.activeIds.length - 1] === tabId) {
				this.freeze(true)
				for (const command of settings.commandOrder) {
					const nextId = await this.selectCommand(command)
					if (nextId !== undefined) {
						await browser.tabs.update(nextId, { active: true })
						this.unfreezeId = nextId
						return
					}
				}
				this.freeze(false)
			}
		} finally {
			this.removeActiveId(tabId)
			await this.trigger()
		}
	}

	freeze(isFrozen) {
		this.isFrozen = isFrozen
		this.unfreezeId = undefined
		this.pendingIds = []
	}

	async trigger() {
		const [tab] = await browser.tabs.query({
			active: true, windowId: this.windowId
		})
		if (this.isFrozen) {
			if (tab) this.pendingIds.push(tab.id)
			if (this.pendingIds.includes(this.unfreezeId)) {
				this.freeze(false)
				await trigger()
			}
			return
		}
		if (tab) {
			this.removeActiveId(tab.id)
			this.activeIds.push(tab.id)
			this.activeIndex = tab.index
			this.activeOpener = tab.openerTabId
		} else {
			this.activeIndex = undefined
			this.activeOpener = undefined
		}
	}

	async selectCommand(command) {
		if (command.relation === 'none') {
			const index = {
				first: 0, last: undefined,
				left: this.activeIndex - 1, right: this.activeIndex,
			}[command.position]
			const tabs = await browser.tabs.query({ index, windowId: this.windowId })
			return tabs.length ? tabs[tabs.length - 1].id : undefined
		}
		const relationMethod = `selectRelation_${command.relation}`
		if (!(relationMethod in this)) return undefined
		const ids = await this[relationMethod]()
		if (typeof ids === 'number' || ids === undefined) return ids

		const tabs = Promise.all(ids.map(
			id => browser.tabs.get(id).catch(() => undefined)))
			.filter(tab => tab && tab.windowId === this.windowId && (
				command.position === 'left' ? tab.index < this.activeIndex :
					command.position === 'right' ? tab.index >= this.activeIndex :
						/* first, last */ true))
		if (!tabs.length) return undefined
		const flip = command.position === 'last' || command.position === 'left'
		return tabs.reduce((v0, v1) => (v0.index < v1.index) !== flip ? v0 : v1).id
	}

	async selectRelation_lastAccessed() {
		return this.activeIds[this.activeIds.length - 2]
	}

	async selectRelation_parent() {
		try {
			const tab = await browser.tabs.get(this.activeOpener)
			return tab.windowId === this.windowId ? tab.id : undefined
		} catch (err) { return undefined }
	}

	async selectRelation_sibling() { }
	async selectRelation_child() { }
	async selectRelation_unread() { }
}

const trackerMap = new Map()

function tracker(windowId) {
	let result = trackerMap.get(windowId)
	if (!result) trackerMap.set(windowId, result = new Tracker(windowId))
	return result
}

reloadSettings().then(() => {
	browser.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
		await tracker(windowId).trigger()
	})

	browser.tabs.onMoved.addListener(async (tabId, { windowId }) => {
		await tracker(windowId).trigger()
	})

	browser.tabs.onDetached.addListener(async (tabId, { oldWindowId }) => {
		await tracker(oldWindowId).remove(tabId)
	})

	browser.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
		await tracker(newWindowId).trigger()
	})

	browser.tabs.onRemoved.addListener(async (tabId, { windowId, isWindowClosing }) => {
		if (isWindowClosing) return
		await tracker(windowId).remove(tabId)
	})

	browser.windows.onRemoved.addListener(windowId => { trackerMap.delete(windowId) })
})