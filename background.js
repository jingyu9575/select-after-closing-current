let commandOrder = []

async function reloadSettings() {
	commandOrder = (await browser.storage.local.get()).commandOrder
	if (!commandOrder || !commandOrder.length) {
		commandOrder = ['lastAccessed', 'left', 'right', 'opener']
		await browser.storage.local.set({ commandOrder })
	}
}
void reloadSettings()

browser.runtime.onMessage.addListener(async message => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'reloadSettings')
		await reloadSettings()
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
				for (const command of commandOrder) {
					try {
						const nextId = await this['selectCommand_' + command]()
						if (nextId !== undefined) {
							await browser.tabs.update(nextId, { active: true })
							this.unfreezeId = nextId
							return
						}
					} catch (err) { }
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

	async selectCommand_left() {
		const [tab] = await browser.tabs.query({
			index: this.activeIndex - 1, windowId: this.windowId
		})
		return tab ? tab.id : undefined
	}

	async selectCommand_right() {
		const [tab] = await browser.tabs.query({
			index: this.activeIndex, windowId: this.windowId
		})
		return tab ? tab.id : undefined
	}

	async selectCommand_opener() {
		try {
			const tab = await browser.tabs.get(this.activeOpener)
			return tab.windowId === this.windowId ? tab.id : undefined
		} catch (err) { return undefined }
	}

	async selectCommand_lastAccessed() {
		return this.activeIds[this.activeIds.length - 2]
	}
}

const trackerMap = new Map()

function tracker(windowId) {
	let result = trackerMap.get(windowId)
	if (!result) trackerMap.set(windowId, result = new Tracker(windowId))
	return result
}

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
