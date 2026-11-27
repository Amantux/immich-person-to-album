const facesEl = document.querySelector('#faces')
const facesStatusEl = document.querySelector('#faces-status')
const albumForm = document.querySelector('#album-form')
const albumSelect = document.querySelector('#album')
const albumStatusEl = document.querySelector('#album-status')
const albumCurrentEl = document.querySelector('#album-current')

let people = []
let albums = []
let links = []
let selectedPersonId = null
let selectedLink = null

function setStatus (element, message) {
  if (!message) {
    element.hidden = true
    element.textContent = ''
    return
  }
  element.hidden = false
  element.textContent = message
}

function getJson (url) {
  return fetch(url).then(async response => {
    if (!response.ok) throw new Error('Request failed with status ' + response.status)
    return response.json()
  })
}

function personLabel (person) {
  const name = person && person.name ? String(person.name).trim() : ''
  return name || 'Unnamed person'
}

function initialsFor (person) {
  const parts = personLabel(person).split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const initial = (parts[0][0] || '?').toUpperCase()
  const second = parts.length > 1 ? (parts[1][0] || '').toUpperCase() : ''
  return initial + second
}

function findLinkForPerson (personId) {
  return links.find(link => (link.personIds || []).includes(personId)) || null
}

function selectPerson (personId) {
  selectedPersonId = personId
  selectedLink = findLinkForPerson(personId)
  renderFaces()
  if (selectedLink && selectedLink.albumId) {
    albumSelect.value = selectedLink.albumId
  } else {
    albumSelect.value = ''
  }
}

function renderFaces () {
  facesEl.innerHTML = ''
  if (!people.length) {
    const empty = document.createElement('li')
    empty.className = 'face-item'
    const emptyMessage = document.createElement('p')
    emptyMessage.className = 'empty'
    emptyMessage.textContent = 'No people were found in the photos.'
    empty.appendChild(emptyMessage)
    facesEl.appendChild(empty)
    setStatus(facesStatusEl, '')
    return
  }
  for (const person of people) {
    const item = document.createElement('li')
    item.className = 'face-item'
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'face'
    button.dataset.personId = person.id
    button.setAttribute('aria-pressed', selectedPersonId === person.id ? 'true' : 'false')
    const thumb = document.createElement('span')
    thumb.className = 'face-thumb'
    const thumbnailPath = person.thumbnailPath || ''
    if (thumbnailPath) {
      const img = document.createElement('img')
      img.src = thumbnailPath
      img.alt = 'Face of ' + personLabel(person)
      img.loading = 'lazy'
      thumb.appendChild(img)
    } else {
      const initials = document.createElement('span')
      initials.className = 'face-initials'
      initials.textContent = initialsFor(person)
      thumb.appendChild(initials)
    }
    const name = document.createElement('p')
    name.className = 'face-name'
    name.textContent = personLabel(person)
    button.appendChild(thumb)
    button.appendChild(name)
    button.addEventListener('click', () => selectPerson(person.id))
    item.appendChild(button)
    facesEl.appendChild(item)
  }
  setStatus(facesStatusEl, people.length ? '' : 'No people were found in the photos.')
}

function renderAlbums () {
  albumSelect.innerHTML = ''
  const current = selectedLink && selectedLink.albumId ? selectedLink.albumId : ''
  for (const album of albums) {
    const option = document.createElement('option')
    option.value = album.id
    option.textContent = album.albumName || 'Untitled album'
    if (album.id === current) option.selected = true
    albumSelect.appendChild(option)
  }
  if (!albums.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'No albums were found.'
    option.disabled = true
    option.selected = true
    albumSelect.appendChild(option)
  }
  albumSelect.required = albums.length > 0
  if (albumCurrentEl) {
    const currentAlbum = albums.find(album => album.id === current) || null
    albumCurrentEl.hidden = !current
    albumCurrentEl.textContent = current && currentAlbum
      ? 'Currently syncing to "' + (currentAlbum.albumName || 'Untitled album') + '".'
      : 'No album has been selected yet.'
  }
}

async function refresh () {
  try {
    const [peopleData, albumsData, linksData] = await Promise.all([
      getJson('/api/people'),
      getJson('/api/albums'),
      getJson('/api/links')
    ])
    people = peopleData.people || []
    albums = albumsData.albums || []
    links = linksData.links || []
    if (selectedPersonId === null) {
      const firstPerson = people.find(person => findLinkForPerson(person.id))
      if (firstPerson) selectPerson(firstPerson.id)
      else renderFaces()
    } else {
      renderFaces()
    }
    renderAlbums()
    setStatus(facesStatusEl, people.length ? '' : 'No people were found in the photos.')
  } catch (error) {
    setStatus(facesStatusEl, 'Could not load the people: ' + (error && error.message ? error.message : 'unknown error'))
  }
}

albumForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const albumId = albumSelect.value
  const personId = selectedPersonId
  if (!albumId) {
    setStatus(albumStatusEl, 'Choose an album before saving.')
    return
  }
  setStatus(albumStatusEl, 'Saving album…')
  try {
    const response = await fetch('/api/links', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ albumId, personIds: personId ? [personId] : [], logic: selectedLink ? selectedLink.logic : 'OR' })
    })
    if (!response.ok) throw new Error('Save failed with status ' + response.status)
    if (selectedLink) {
      selectedLink.albumId = albumId
    } else {
      selectedLink = { albumId, personIds: personId ? [personId] : [], logic: 'OR' }
    }
    setStatus(albumStatusEl, 'Saved. The sync will add the matching photos to the album.')
    renderAlbums()
  } catch (error) {
    setStatus(albumStatusEl, 'Could not save the album: ' + (error && error.message ? error.message : 'unknown error'))
  }
})

window.addEventListener('error', (event) => {
  setStatus(facesStatusEl, 'A page error occurred: ' + (event && event.message ? event.message : 'unknown error'))
})

refresh()
