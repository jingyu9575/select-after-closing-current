let DEBUG = false

let globalSettings = { commandOrder: [] }
let exclusions = []
let customNewTabUrl = 'about:newtab'

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
	exclusions = new Set((settings.exclusions || '').split(/[\r\n]/).map(v => v.trim()))
	exclusions.delete('')
}

async function loadCustomNewTabUrl() {
	if (!browser.browserSettings || !browser.browserSettings.newTabPageOverride)
		return
	customNewTabUrl = (await browser.browserSettings.newTabPageOverride.get({})).value
}
loadCustomNewTabUrl()

browser.runtime.onMessage.addListener(async message => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'reloadSettings') {
		await reloadSettings()
		return globalSettings
	} else if (message.type === 'loadCustomNewTabUrl') {
		loadCustomNewTabUrl()
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
	*lastAccessed({ tabId, windowInfo }) {
		for (let i = windowInfo.recent.length; i-- > 0;) {
			const value = windowInfo.recent[i]
			if (value !== tabId) yield value
		}
	},
	*parent({ tabId, windowId }) {
		const result = tabInfoMap.get(tabId).openerTabId
		if (result != undefined && tabInfoMap.has(result) &&
			tabInfoMap.get(result).windowId === windowId)
			yield result
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
	unreadChild(target, data) {
		return multipleRelationPredicates.unread(target, data)
			&& multipleRelationPredicates.child(target, data)
	},
	unreadSibling(target, data) {
		return multipleRelationPredicates.unread(target, data)
			&& multipleRelationPredicates.sibling(target, data)
	},
	pinned(target) { return tabInfoMap.get(target).pinned },
	unpinned(target) { return !tabInfoMap.get(target).pinned },
}

function isSelectionAllowed(command, selectedId) {
	const tabInfo = tabInfoMap.get(selectedId)
	if (!tabInfo) return false
	if (exclusions.has(tabInfo.url)) return false
	if (command.skipHidden && tabInfo.hidden) return false
	if (command.skipUnloaded && tabInfo.discarded) return false
	return true
}

function selectCommand(command, data /* { tabId, windowId, windowInfo } */) {
	const { tabs } = data.windowInfo
	const isPositionFiltered = command.position !== 'first'
		&& command.position !== 'last'
	const index = isPositionFiltered ? tabs.indexOf(data.tabId) : 0
	const [begin, end, step] = {
		first: [0, tabs.length, 1],
		last: [tabs.length - 1, -1, -1],
		left: [index - 1, -1, -1],
		right: [index + 1, tabs.length, 1],
		leftAdjacent: [index - 1, Math.max(index - 2, -1), -1],
		rightAdjacent: [index + 1, Math.min(index + 2, tabs.length), 1],
	}[command.position]
	if (command.relation in singleRelationMethods) {
		for (const selectedId of singleRelationMethods[command.relation](data)) {
			if (isPositionFiltered) {
				const selectedIndex = tabs.indexOf(selectedId)
				if (!(step > 0 ? selectedIndex >= begin && selectedIndex < end :
					selectedIndex <= begin && selectedIndex > end)) continue
			}
			if (isSelectionAllowed(command, selectedId))
				return selectedId
		}
		return undefined
	}
	if (command.relation in multipleRelationPredicates) {
		if (index === -1) return undefined
		const predicate = multipleRelationPredicates[command.relation]
		for (let i = begin; i !== end; i += step)
			if (tabs[i] !== data.tabId && predicate(tabs[i], data)
				&& isSelectionAllowed(command, tabs[i]))
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
			windowInfo.newTabStatus && windowInfo.newTabStatus.tabId === tabId) &&
		globalSettings.operatingMode !== 'no-classic') {
		const selectedId = resolveSelection({ tabId, windowId, windowInfo })
		if (selectedId !== undefined) {
			if (DEBUG) console.log(`selected ${selectedId}`)
			windowInfo.frozenStatus = []
			browser.tabs.update(selectedId, { active: true }).then(
				() => {
					unfreezeWindow(windowInfo, selectedId)
					preloadWindow(windowId)
				},
				err => {
					console.error(err)
					unfreezeWindow(windowInfo, undefined)
					preloadWindow(windowId)
				}
			)
		}
	}
	arrayRemoveOne(windowInfo.tabs, tabId)
	arrayRemoveOne(windowInfo.recent, tabId)
}

function doCreateTab({
	id, windowId, index, openerTabId, hidden, discarded, pinned, url
}) {
	if (tabInfoMap.has(id)) return // may be called twice on startup
	tabInfoMap.set(id,
		{ windowId, openerTabId, unread: false, hidden, discarded, pinned, url })
	windowInfoMap.insert(windowId).tabs.splice(index, 0, id)
}

function isNewTabUrl(url) {
	return url === 'about:newtab' || url === 'about:blank' || url === customNewTabUrl
}

browser.tabs.onCreated.addListener(tab => {
	if (DEBUG) console.log(`tabs.onCreated ${tab.id}`)
	if (tab.active && isNewTabUrl(tab.url))
		windowInfoMap.insert(tab.windowId).newTabStatus = { tabId: tab.id }
	doCreateTab(tab)
	checkConsistency()
	preloadWindow(tab.windowId)
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
	preloadWindow(windowId)
})

browser.tabs.onMoved.addListener((tabId, { windowId, toIndex }) => {
	if (DEBUG) console.log(`tabs.onMoved ${tabId}`)
	const windowInfo = windowInfoMap.insert(windowId)
	if (!arrayRemoveOne(windowInfo.tabs, tabId)) return
	windowInfo.tabs.splice(toIndex, 0, tabId)
	checkConsistency()
	preloadWindow(windowId)
})

browser.tabs.onAttached.addListener((tabId, { newWindowId, newPosition }) => {
	if (DEBUG) console.log(`tabs.onAttached ${tabId}`)
	if (tabInfoMap.has(tabId)) tabInfoMap.get(tabId).windowId = newWindowId
	windowInfoMap.insert(newWindowId).tabs.splice(newPosition, 0, tabId)
	checkConsistency()
	preloadWindow(newWindowId)
})

browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => {
	if (DEBUG) console.log(`tabs.onDetached ${tabId}`)
	doDetachTab(tabId, oldWindowId)
	checkConsistency(true)
	preloadWindow(oldWindowId)
})

browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) => {
	if (DEBUG) console.log(`tabs.onRemoved ${tabId}`)
	if (!isWindowClosing) doDetachTab(tabId, windowId)
	tabInfoMap.delete(tabId)
	if (!isWindowClosing) {
		checkConsistency(true)
		preloadWindow(windowId)
	}
})

browser.windows.onRemoved.addListener(windowId => {
	windowInfoMap.delete(windowId)
})

browser.tabs.onUpdated.addListener((tabId,
	{ status, url, hidden, discarded, pinned }, { active, windowId }) => {
	const windowInfo = windowInfoMap.insert(windowId)
	const tabInfo = tabInfoMap.get(tabId)

	let changed = false
	if (url) {
		if (exclusions.has(url) !== exclusions.has(tabInfo.url))
			changed = true
		if (windowInfo.newTabStatus && windowInfo.newTabStatus.tabId === tabId
			&& !isNewTabUrl(url)) {
			windowInfo.newTabStatus = undefined
			changed = true
		}
		tabInfo.url = url
	}
	if (!active && status === 'complete' && tabInfo) {
		if (DEBUG) console.log(`tab is unread ${tabId}`)
		tabInfo.unread = true
		changed = true
	}
	if (hidden != undefined && tabInfo) {
		if (DEBUG) console.log(`tab hidden updated ${tabId} ${hidden}`)
		tabInfo.hidden = hidden
		changed = true
	}
	if (discarded != undefined && tabInfo) {
		if (DEBUG) console.log(`tab discarded updated ${tabId} ${discarded}`)
		tabInfo.discarded = discarded
		changed = true
	}
	if (pinned != undefined && tabInfo) {
		if (DEBUG) console.log(`tab pinned updated ${tabId} ${pinned}`)
		tabInfo.pinned = pinned
		changed = true
	}
	if (changed) preloadWindow(windowId)
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

function preloadWindow(windowId) {
	if (!('moveInSuccession' in browser.tabs)) return
	if (globalSettings.operatingMode === 'no-preload') return
	const windowInfo = windowInfoMap.insert(windowId)
	const tabId = windowInfo.recent[windowInfo.recent.length - 1]
	if (tabId === undefined) return
	const successorTabId = resolveSelection({ tabId, windowId, windowInfo })
	if (successorTabId === undefined) return
	if (DEBUG) console.log(`preloadWindow ${windowId} ${successorTabId}`)
	void browser.tabs.update(tabId, { successorTabId })
}

const initialization = async function () {
	for (const tab of await browser.tabs.query({})) doCreateTab(tab)
	await reloadSettings()
	for (const { id } of await browser.windows.getAll()) preloadWindow(id)
}()

browser.runtime.onInstalled.addListener(async ({ reason }) => {
	if (reason !== "install") return
	if (!('moveInSuccession' in browser.tabs)) return
	await initialization
	await browser.storage.local.set({ disableFromNewTab: true })
	await reloadSettings()
})