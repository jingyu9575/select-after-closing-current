for (const element of document.querySelectorAll('[data-i18n]'))
	element.innerText = browser.i18n.getMessage(element.dataset['i18n'])

const commandTemplate = document.getElementById("commandTemplate")
const commandOrderDiv = document.getElementById("commandOrder")

async function reloadSettings() {
	const { commandOrder } = await browser.storage.local.get()
	if (!commandOrder) return
	for (const commandString of commandOrder.slice().reverse()) {
		for (const command of commandOrderDiv.querySelectorAll('.command')) {
			if (command.dataset['command'] === commandString) {
				if (command !== command.parentNode.firstElementChild)
					command.parentNode.insertBefore(command,
						command.parentNode.firstElementChild)
				break
			}
		}
	}
}

async function moveCommand(command, position) {
	command.parentNode.insertBefore(command, position)

	await browser.storage.local.set({
		commandOrder: [...commandOrderDiv.querySelectorAll('.command')].map(
			v => v.dataset['command'])
	})
	await browser.runtime.sendMessage({ type: 'reloadSettings' })
}

void async function () {
	await reloadSettings()
	for (const command of commandOrderDiv.querySelectorAll('.command')) {
		command.appendChild(document.importNode(commandTemplate.content, true))
		command.querySelector('.commandText').innerText =
			browser.i18n.getMessage('command_' + command.dataset['command'])

		command.querySelector('.up').addEventListener('click', async () => {
			const prev = command.previousElementSibling
			if (prev == null) return
			await moveCommand(command, prev)
		}, false)
		command.querySelector('.down').addEventListener('click', async () => {
			const next = command.nextElementSibling
			if (next == null) return
			await moveCommand(command, next.nextElementSibling)
		}, false)
	}
}()