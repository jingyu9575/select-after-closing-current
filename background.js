let DEBUG = false

let globalSettings = { commandOrder: [] }

async function reloadSettings() {
	const settings = await browser.storage.local.get()
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
	globalSettings = settings
}

browser.runtime.onMessage.addListener(async message => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'reloadSettings') {
		await reloadSettings()
		return globalSettings
	}
})

function mapInsert(map, key, fn) {
	if (map.has(key)) return map.get(key)
	const value = fn()
	map.set(key, value)
	return value
}

class InsertableMap extends Map {
	constructor(defaultConstructor, entries) {
		super(entries)
		this.defaultConstructor = defaultConstructor
	}

	insert(key, fn) {
		return mapInsert(this, key, () => (fn || this.defaultConstructor)(key))
	}
}

function arrayRemoveOne(arr, item) {
	const i = arr.indexOf(item)
	if (i > -1) { arr.splice(i, 1); return true }
	return false
}

const tabInfoMap = new Map()
const windowInfoMap = new InsertableMap(() => ({
	tabs: [], recent: [],
	frozenStatus: undefined /* as undefined | number | number[] */,
	newTabStatus: undefined /* as undefined | {tabId: number} */,
}))

function checkConsistency(skipActive) {
	if (!DEBUG) return
	browser.tabs.query({}).then(tabs => {
		try {
			for (const tab of tabs) {
				if (tabInfoMap.get(tab.id).windowId !== tab.windowId)
					throw new Error(`inconsistent windowId of ${tab.id}`)
				if (windowInfoMap.get(tab.windowId).tabs[tab.index] !== tab.id)
					throw new Error(`inconsistent index of ${tab.id}`)
				if (!skipActive && tab.active) {
					const recent = windowInfoMap.get(tab.windowId).recent.slice(-1)[0]
					if (recent !== undefined && recent !== tab.id)
						throw new Error(`inconsistent active of ${tab.id}`)
				}
			}
			for (const [windowId, windowInfo] of windowInfoMap.entries()) {
				if (windowInfo.tabs.length !== tabs.filter(
					tab => tab.windowId === windowId).length)
					throw new Error(`inconsistent windowId of ${windowId}`)
			}
		} catch (err) { console.error(err) }
	})
}

function doActivateTab(tabId, windowInfo) {
	arrayRemoveOne(windowInfo.recent, tabId)
	windowInfo.recent.push(tabId)
	const tabInfo = tabInfoMap.get(tabId)
	if (tabInfo && tabInfo.unread) {
		if (DEBUG) console.log(`tab is read ${tabId}`)
		tabInfo.unread = false
	}
}

function unfreezeWindow(windowInfo, selectedId) {
	if (DEBUG) console.log(`unfreezeWindow ${selectedId}`)
	const pendingIds = windowInfo.frozenStatus
	windowInfo.frozenStatus = selectedId
	if (!Array.isArray(pendingIds)) return
	const index = selectedId === undefined ? /* all */ 0 :
		pendingIds.indexOf(selectedId)
	if (index === -1) return
	windowInfo.frozenStatus = undefined
	for (let i = index; i < pendingIds.length; ++i)
		doActivateTab(pendingIds[i], windowInfo)
}

const singleRelationMethods = {
	lastAccessed({ tabId, windowInfo }) {
		const last = windowInfo.recent[windowInfo.recent.length - 1]
		return last !== tabId ? last :
			windowInfo.recent[windowInfo.recent.length - 2]
	},
	parent({ tabId, windowId }) {
		const result = tabInfoMap.get(tabId).openerTabId
		return result != undefined && tabInfoMap.has(result) &&
			tabInfoMap.get(result).windowId === windowId ? result : undefined
	},
}

const multipleRelationPredicates = {
	none() { return true },
	sibling(target, { tabId }) {
		const opener0 = tabInfoMap.get(tabId).openerTabId,
			opener1 = tabInfoMap.get(target).openerTabId
		return opener0 != undefined && opener0 === opener1
	},
	child(target, { tabId }) {
		return tabInfoMap.get(target).openerTabId === tabId
	},
	unread(target) { return tabInfoMap.get(target).unread },
	unreadChild(target, { tabId }) {
		const tabInfo = tabInfoMap.get(target)
		return tabInfo.openerTabId === tabId && tabInfo.unread
	},
}

function selectCommand(command, data /* { tabId, windowId, windowInfo } */) {
	if (command.relation in singleRelationMethods)
		return singleRelationMethods[command.relation](data)
	if (command.relation in multipleRelationPredicates) {
		const { tabs } = data.windowInfo
		const index = ['left', 'right'].includes(command.position) ?
			tabs.indexOf(data.tabId) : 0
		if (index === -1) return undefined
		const [begin, end, step] = {
			first: [0, tabs.length, 1],
			last: [tabs.length - 1, -1, -1],
			left: [index - 1, -1, -1],
			right: [index + 1, tabs.length, 1],
		}[command.position]
		const predicate = multipleRelationPredicates[command.relation]
		for (let i = begin; i !== end; i += step)
			if (tabs[i] !== data.tabId && predicate(tabs[i], data))
				return tabs[i]
	}
	return undefined
}

const ignoredClose = new Set()

function resolveSelection({ tabId, windowId, windowInfo, shortcutId }) {
	if (ignoredClose.delete(tabId)) return undefined
	for (const command of globalSettings.commandOrder) {
		if (shortcutId && command.closeShortcut !== shortcutId)
			continue
		try {
			const selectedId = selectCommand(command,
				{ tabId, windowId, windowInfo })
			if (selectedId !== undefined) return selectedId
		} catch (err) { console.error(err) }
	}
	return undefined
}

function doDetachTab(tabId, windowId) {
	const windowInfo = windowInfoMap.insert(windowId)
	if (typeof windowInfo.frozenStatus === 'number' &&
		tabId === windowInfo.frozenStatus)
		windowInfo.frozenStatus = undefined
	if (tabId === windowInfo.recent[windowInfo.recent.length - 1] &&
		!Array.isArray(windowInfo.frozenStatus) &&
		!(globalSettings.disableFromNewTab &&
			windowInfo.newTabStatus && windowInfo.newTabStatus.tabId === tabId)) {
		const selectedId = resolveSelection({ tabId, windowId, windowInfo })
		if (selectedId !== undefined) {
			if (DEBUG) console.log(`selected ${selectedId}`)
			windowInfo.frozenStatus = []
			browser.tabs.update(selectedId, { active: true }).then(
				() => unfreezeWindow(windowInfo, selectedId),
				err => {
					console.error(err)
					unfreezeWindow(windowInfo, undefined)
				}
			)
		}
	}
	arrayRemoveOne(windowInfo.tabs, tabId)
	arrayRemoveOne(windowInfo.recent, tabId)
}

function doCreateTab({ id, windowId, index, openerTabId }) {
	if (tabInfoMap.has(id)) return // may be called twice on startup
	tabInfoMap.set(id, { windowId, openerTabId, unread: false })
	windowInfoMap.insert(windowId).tabs.splice(index, 0, id)
}

browser.tabs.onCreated.addListener(tab => {
	if (DEBUG) console.log(`tabs.onCreated ${tab.id}`)
	if (tab.active && tab.url === 'about:newtab')
		windowInfoMap.insert(tab.windowId).newTabStatus = { tabId: tab.id }
	doCreateTab(tab)
	checkConsistency()
})

function onActivated(tabId, windowId) {
	const windowInfo = windowInfoMap.insert(windowId)
	if (windowInfo.newTabStatus && windowInfo.newTabStatus.tabId !== tabId)
		windowInfo.newTabStatus = undefined
	if (typeof windowInfo.frozenStatus === 'number') {
		if (tabId !== windowInfo.frozenStatus) return
		windowInfo.frozenStatus = undefined
	} else if (Array.isArray(windowInfo.frozenStatus)) {
		windowInfo.frozenStatus.push(tabId)
		return
	}
	doActivateTab(tabId, windowInfo)
	checkConsistency()
}

browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
	if (DEBUG) console.log(`tabs.onActivated ${tabId}`)
	if (globalSettings.bug1366290Mitigation) {
		browser.tabs.query({ active: true, windowId: windowId }).then(() => {
			if (DEBUG) console.log(`bug1366290 mitigation ${tabId}`)
			onActivated(tabId, windowId)
		})
	} else onActivated(tabId, windowId)
})

browser.tabs.onMoved.addListener((tabId, { windowId, toIndex }) => {
	if (DEBUG) console.log(`tabs.onMoved ${tabId}`)
	const windowInfo = windowInfoMap.insert(windowId)
	if (!arrayRemoveOne(windowInfo.tabs, tabId)) return
	windowInfo.tabs.splice(toIndex, 0, tabId)
	checkConsistency()
})

browser.tabs.onAttached.addListener((tabId, { newWindowId, newPosition }) => {
	if (DEBUG) console.log(`tabs.onAttached ${tabId}`)
	if (tabInfoMap.has(tabId)) tabInfoMap.get(tabId).windowId = newWindowId
	windowInfoMap.insert(newWindowId).tabs.splice(newPosition, 0, tabId)
	checkConsistency()
})

browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
	if (DEBUG) console.log(`tabs.onDetached ${tabId}`)
	doDetachTab(tabId, oldWindowId)
	checkConsistency(true)
})

browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
	if (DEBUG) console.log(`tabs.onRemoved ${tabId}`)
	if (!isWindowClosing) doDetachTab(tabId, windowId)
	tabInfoMap.delete(tabId)
	if (!isWindowClosing) checkConsistency(true)
})

browser.windows.onRemoved.addListener(windowId => {
	windowInfoMap.delete(windowId)
})

browser.tabs.onUpdated.addListener((tabId, { status, url }, { active, windowId }) => {
	const windowInfo = windowInfoMap.insert(windowId)
	if (url && windowInfo.newTabStatus && windowInfo.newTabStatus.tabId === tabId)
		windowInfo.newTabStatus = undefined
	const tabInfo = tabInfoMap.get(tabId)
	if (!active && status === 'complete' && tabInfo) {
		if (DEBUG) console.log(`tab is unread ${tabId}`)
		tabInfo.unread = true
	}
})

browser.commands.onCommand.addListener(async command => {
	const match = /^close-(\d+)$/.exec(command)
	if (match) {
		const shortcutId = match[1]
		if (!globalSettings.commandOrder.some(v => v.closeShortcut === shortcutId))
			return
		const [tab] = await browser.tabs.query({ currentWindow: true, active: true })
		if (!tab) return
		const { windowId } = tab
		const windowInfo = windowInfoMap.insert(windowId)
		const selectedId = resolveSelection(
			{ tabId: tab.id, windowId, windowInfo, shortcutId })
		if (selectedId !== undefined)
			void browser.tabs.update(selectedId, { active: true })
		ignoredClose.add(tab.id)
		void browser.tabs.remove(tab.id)
	}
})

void async function () {
	for (const tab of await browser.tabs.query({})) doCreateTab(tab)
	await reloadSettings()
}()
