this.selectAfterClosingCurrent = class extends ExtensionAPI {
	getAPI(context) {
		const { windowManager, tabManager } = context.extension

		function patchGBrowser(gBrowser) {
			if ('selectAfterClosingCurrent_tabToBlurTo' in gBrowser) return
			const { _findTabToBlurTo } = gBrowser
			gBrowser._findTabToBlurTo = function (tab) {
				if (!tab.selected) return null
				const id = this.selectAfterClosingCurrent_tabToBlurTo
				if (id != undefined && id >= 0) {
					try {
						const { nativeTab } = tabManager.get(id)
						if (nativeTab.ownerDocument === this.ownerDocument)
							return nativeTab
					} catch (error) { console.error(error) }
				}
				return _findTabToBlurTo.apply(this, arguments)
			}
		}

		return {
			selectAfterClosingCurrent: {
				async setTabToBlurTo(windowId, tabId) {
					const { gBrowser } = windowManager.get(windowId).window
					if (tabId !== -1) tabManager.get(tabId)
					patchGBrowser(gBrowser)
					gBrowser.selectAfterClosingCurrent_tabToBlurTo = tabId
				}
			},
		}
	}
}