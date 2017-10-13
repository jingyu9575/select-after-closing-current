for (const element of document.querySelectorAll('[data-i18n]'))
	element.innerText = browser.i18n.getMessage(element.dataset['i18n'])

const commandTemplate = document.getElementById("commandTemplate")
const commandOrderDiv = document.getElementById("commandOrder")
const bug1366290MitigationInput = document.getElementById("bug1366290MitigationInput")

function updateSingleRelationStyle(command) {
	const relationSelect = command.querySelector('.relationSelect')
	const option = relationSelect.options[relationSelect.selectedIndex]
	command.classList.toggle('singleRelation', option &&
		option.classList.contains('singleRelation'))
}

function addCommand() {
	const command = document.createElement('div')
	command.classList.add('command')
	command.appendChild(document.importNode(commandTemplate.content, true))
	for (const option of command.querySelectorAll('select option'))
		option.innerText = browser.i18n.getMessage(
			`${option.parentElement.dataset['key']}_${option.value}`)
	for (const button of command.querySelectorAll('button'))
		button.title = browser.i18n.getMessage(button.dataset['i18nTitle'])
	commandOrderDiv.appendChild(command)
	commandOrderDiv.classList.add('hasCommand')

	command.querySelector('.relationSelect').addEventListener('change',
		() => { updateSingleRelationStyle(command) })

	command.querySelector('.up').addEventListener('click', () => {
		const prev = command.previousElementSibling
		if (prev == null || !prev.classList.contains('command')) return
		command.parentNode.insertBefore(command, prev)
	})
	command.querySelector('.down').addEventListener('click', () => {
		const next = command.nextElementSibling
		if (next == null || !next.classList.contains('command')) return
		command.parentNode.insertBefore(command, next.nextElementSibling)
	})
	command.querySelector('.remove').addEventListener('click', () => {
		command.remove()
		commandOrderDiv.classList.toggle('hasCommand',
			!!commandOrderDiv.querySelector(".command"))
	})

	for (const select of command.querySelectorAll('select'))
		select.addEventListener('change', saveSettings)
	for (const button of command.querySelectorAll('button'))
		button.addEventListener('click', saveSettings)
	return command
}

document.getElementById('add').addEventListener('click',
	() => { addCommand(); saveSettings() })

let settings = {}

async function reloadSettings() {
	settings = await browser.runtime.sendMessage(
		{ type: 'reloadSettings' })
	for (const command of commandOrderDiv.querySelectorAll('.command'))
		command.remove()
	for (const obj of settings.commandOrder) {
		const command = addCommand()
		for (const select of command.querySelectorAll('select'))
			select.value = obj[select.dataset['key']]
		updateSingleRelationStyle(command)
	}
	bug1366290MitigationInput.checked = !!settings.bug1366290Mitigation
}

async function saveSettings() {
	settings.commandOrder = []
	for (const command of commandOrderDiv.querySelectorAll('.command')) {
		const obj = {}
		for (const select of command.querySelectorAll('select'))
			obj[select.dataset['key']] = select.value
		settings.commandOrder.push(obj)
	}
	settings.bug1366290Mitigation = !!bug1366290MitigationInput.checked
	await browser.storage.local.set(settings)
	await browser.runtime.sendMessage({ type: 'reloadSettings' })
}

bug1366290MitigationInput.addEventListener('change', saveSettings)

void async function () {
	await reloadSettings()
	document.getElementById('add').disabled = false
}()