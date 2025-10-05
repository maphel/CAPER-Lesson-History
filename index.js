// ==UserScript==
// @name         CAPER Lesson History Helper
// @namespace    https://github.com/maphel/CAPER-Lesson-History
// @version      1.3.1
// @updateURL    https://raw.githubusercontent.com/maphel/CAPER-Lesson-History/main/index.js
// @downloadURL  https://raw.githubusercontent.com/maphel/CAPER-Lesson-History/main/index.js
// @description  Capture CAPER lesson/store submissions, keep a local history, and provide quick reuse tools directly on the page. Includes a debug harness for testing off-site.
// @author       maphel
// @match        https://caper.sks.go.th/*
// @run-at       document-start
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.setClipboard
// @grant        GM.addStyle
// ==/UserScript==

/* global GM, GM_getValue, GM_setValue, GM_deleteValue, GM_setClipboard, GM_addStyle */

;(function () {
  'use strict'

  const STORAGE_KEY = 'caperLessonHistory'
  const HISTORY_LIMIT = 50
  const TARGET_PATH_FRAGMENT = '/lesson/store'
  const DEBUG_QUERY_PARAM = 'caper-history-debug'
  const DEBUG_STORAGE_KEY = 'caperHistoryDebug'
  const PANEL_COLLAPSED_KEY = 'caperHistoryPanelCollapsed'

  const DEBUG_MODE = detectDebugMode()
  if (DEBUG_MODE) {
    console.info('[CaperHistory] Debug mode active')
  }

  let historyCache = []
  let panelCollapsed = false
  let panelRoot = null
  let entriesContainer = null
  let emptyStateEl = null
  let toggleButton = null
  let lastRender = ''

  const historyReady = loadHistory()
  const panelStateReady = loadPanelState()
  const bootstrapReady = Promise.all([historyReady, panelStateReady])

  hookNetwork()

  onDocumentReady(async () => {
    await bootstrapReady
    injectStyles()
    buildPanel()
    if (DEBUG_MODE) {
      registerDebugHarness()
    }
    renderHistory()
  })

  async function loadHistory() {
    historyCache = await gmGetValue(STORAGE_KEY, [])
    if (!Array.isArray(historyCache)) {
      historyCache = []
    }
  }

  async function loadPanelState() {
    const stored = await gmGetValue(PANEL_COLLAPSED_KEY, false)
    panelCollapsed = stored === true || stored === 'true' || stored === 1
  }

  function detectDebugMode() {
    let debugParam = null
    try {
      debugParam = new URLSearchParams(window.location.search).get(DEBUG_QUERY_PARAM)
    } catch (error) {
      debugParam = null
    }

    if (debugParam === '1') {
      persistDebugPreference(true)
      return true
    }

    if (debugParam === '0') {
      persistDebugPreference(false)
      return false
    }

    try {
      if (window.localStorage && window.localStorage.getItem(DEBUG_STORAGE_KEY) === '1') {
        return true
      }
    } catch (error) {
      // ignore storage access errors
    }

    return false
  }

  function persistDebugPreference(enabled) {
    try {
      if (!window.localStorage) {
        return
      }
      if (enabled) {
        window.localStorage.setItem(DEBUG_STORAGE_KEY, '1')
      } else {
        window.localStorage.removeItem(DEBUG_STORAGE_KEY)
      }
    } catch (error) {
      // ignore storage access errors
    }
  }

  function hookNetwork() {
    hookFetch()
    hookXHR()
  }

  function hookFetch() {
    if (typeof window.fetch !== 'function') {
      return
    }

    const originalFetch = window.fetch

    window.fetch = async function (...args) {
      const captureContext = await extractFetchDetails(args)
      let response

      try {
        response = await originalFetch.apply(this, args)
      } catch (error) {
        if (captureContext) {
          captureContext.status = 0
          captureContext.errorMessage = error instanceof Error ? error.message : String(error)
          finalizeCapture(captureContext)
        }
        throw error
      }

      if (captureContext) {
        captureContext.status = response.status
        finalizeCapture(captureContext)
      }

      return response
    }
  }

  async function extractFetchDetails(args) {
    const [resource, init = {}] = args
    let url = ''
    let method = 'GET'
    let bodyString = null

    if (typeof resource === 'string') {
      url = resource
      method = init.method ? String(init.method) : 'GET'
      bodyString = await normaliseBody(init.body)
    } else if (resource && typeof resource === 'object' && 'url' in resource) {
      url = resource.url
      method = resource.method || (init && init.method) || 'GET'
      if (init && init.body) {
        bodyString = await normaliseBody(init.body)
      } else if (resource.bodyUsed === false) {
        try {
          const clone = resource.clone()
          bodyString = await normaliseBody(await clone.text())
        } catch (error) {
          console.warn('[CaperHistory] Failed to read fetch body', error)
        }
      }
    }

    method = method ? String(method).toUpperCase() : 'GET'

    if (shouldCapture(url, method) && bodyString) {
      return {
        url,
        method,
        bodyString,
      }
    }

    return null
  }

  function hookXHR() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype
    if (!proto) {
      return
    }

    const originalOpen = proto.open
    const originalSend = proto.send
    const originalSetRequestHeader = proto.setRequestHeader

    proto.open = function (method, url, ...rest) {
      this.__caperInfo = {
        method: method ? String(method).toUpperCase() : 'GET',
        url,
        headers: {},
      }
      return originalOpen.call(this, method, url, ...rest)
    }

    proto.setRequestHeader = function (name, value) {
      if (this.__caperInfo) {
        this.__caperInfo.headers[name.toLowerCase()] = value
      }
      return originalSetRequestHeader.call(this, name, value)
    }

    proto.send = function (body) {
      if (this.__caperInfo && shouldCapture(this.__caperInfo.url, this.__caperInfo.method)) {
        Promise.resolve(normaliseBody(body)).then((bodyString) => {
          if (!bodyString) {
            return
          }

          const captureEntry = {
            url: absolutifyUrl(this.__caperInfo.url),
            method: this.__caperInfo.method,
            bodyString,
            headers: this.__caperInfo.headers,
          }

          this.addEventListener(
            'loadend',
            () => {
              captureEntry.status = this.status
              if (this.status === 0 && this.statusText) {
                captureEntry.errorMessage = this.statusText
              }
              finalizeCapture(captureEntry)
            },
            { once: true }
          )
        })
      }

      return originalSend.call(this, body)
    }
  }

  function shouldCapture(url, method) {
    if (!url || !method || method.toUpperCase() !== 'POST') {
      return false
    }
    try {
      const absoluteUrl = new URL(url, window.location.href)
      return absoluteUrl.pathname.includes(TARGET_PATH_FRAGMENT)
    } catch (error) {
      return false
    }
  }

  async function normaliseBody(body) {
    if (!body) {
      return null
    }

    if (body instanceof Promise) {
      return await body
    }

    if (typeof body === 'string') {
      return body
    }

    if (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) {
      return body.toString()
    }

    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      const params = new URLSearchParams()
      for (const [key, value] of body.entries()) {
        if (typeof value === 'string') {
          params.append(key, value)
        }
      }
      return params.toString()
    }

    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      try {
        const reader = new FileReader()
        return await new Promise((resolve) => {
          reader.addEventListener('loadend', () => {
            resolve(typeof reader.result === 'string' ? reader.result : null)
          })
          reader.addEventListener('error', () => resolve(null))
          reader.readAsText(body)
        })
      } catch (error) {
        return null
      }
    }

    if (typeof ArrayBuffer !== 'undefined' && (body instanceof ArrayBuffer || ArrayBuffer.isView(body))) {
      try {
        const view = body instanceof ArrayBuffer ? new Uint8Array(body) : body
        return new TextDecoder().decode(view)
      } catch (error) {
        return null
      }
    }

    if (typeof body === 'object' && 'toString' in body) {
      try {
        return body.toString()
      } catch (error) {
        return null
      }
    }

    return null
  }

  async function finalizeCapture(rawEntry) {
    const bodyString = await resolveMaybePromise(rawEntry.bodyString)
    if (!bodyString) {
      return
    }

    const payload = parsePayload(bodyString)
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      capturedAt: new Date().toISOString(),
      url: absolutifyUrl(rawEntry.url),
      method: rawEntry.method,
      status: rawEntry.status,
      error: rawEntry.errorMessage || null,
      body: bodyString,
      payload,
    }

    await historyReady
    historyCache.unshift(entry)
    if (historyCache.length > HISTORY_LIMIT) {
      historyCache.length = HISTORY_LIMIT
    }
    await gmSetValue(STORAGE_KEY, historyCache)
    renderHistory()
    console.info('[CaperHistory] Captured submission', entry)
  }

  function parsePayload(bodyString) {
    const params = new URLSearchParams(bodyString)
    const payload = {}

    for (const [key, value] of params.entries()) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        const current = payload[key]
        if (Array.isArray(current)) {
          current.push(value)
        } else {
          payload[key] = [current, value]
        }
      } else {
        payload[key] = value
      }
    }

    return payload
  }

  function buildPanel() {
    if (panelRoot) {
      return
    }

    panelRoot = document.createElement('section')
    panelRoot.className = 'caper-history-panel'
    panelRoot.innerHTML = `
      <header class="caper-history-panel__header">
        <div class="caper-history-panel__heading">
          <h2 class="caper-history-panel__title">Lesson History</h2>
          <button type="button" class="caper-history-toggle" aria-expanded="true" aria-label="Collapse lesson history panel">
            <span class="caper-history-toggle__icon">−</span>
          </button>
        </div>
        <button type="button" class="caper-history-clear">Clear history</button>
      </header>
      <div class="caper-history-panel__body">
        <p class="caper-history-empty">No lesson submissions captured yet.</p>
        <div class="caper-history-list"></div>
      </div>
    `

    entriesContainer = panelRoot.querySelector('.caper-history-list')
    emptyStateEl = panelRoot.querySelector('.caper-history-empty')
    toggleButton = panelRoot.querySelector('.caper-history-toggle')

    panelRoot
      .querySelector('.caper-history-clear')
      .addEventListener('click', async () => {
        historyCache = []
        await gmSetValue(STORAGE_KEY, historyCache)
        renderHistory()
      })

    toggleButton.addEventListener('click', () => {
      panelCollapsed = !panelCollapsed
      applyCollapsedState()
      gmSetValue(PANEL_COLLAPSED_KEY, panelCollapsed)
    })

    entriesContainer.addEventListener('click', async (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      const action = target.dataset.action
      if (!action) {
        return
      }

      const cardEl = target.closest('.caper-history-entry')
      if (!cardEl) {
        return
      }

      const entryId = cardEl.dataset.entryId
      const entry = historyCache.find((item) => item.id === entryId)
      if (!entry) {
        return
      }

      if (action === 'fill') {
        fillFormFromEntry(entry, { paste: false })
      } else if (action === 'paste') {
        fillFormFromEntry(entry, { paste: true })
      } else if (action === 'copy') {
        copyPayload(entry.body)
      } else if (action === 'delete') {
        await deleteEntry(entryId)
      }
    })

    document.body.appendChild(panelRoot)
    applyCollapsedState()
  }

  function registerDebugHarness() {
    const debugPanel = document.createElement('aside')
    debugPanel.className = 'caper-history-debug'
    debugPanel.innerHTML = `
      <header class="caper-history-debug__header">
        <strong>Debug tools</strong>
        <small>Query: ?${DEBUG_QUERY_PARAM}=0 to disable</small>
      </header>
      <p class="caper-history-debug__body">
        Use these buttons to populate the history without sending real CAPER requests.
      </p>
      <div class="caper-history-debug__actions">
        <button type="button" data-debug="single">Add single-day sample</button>
        <button type="button" data-debug="range">Add multi-day sample</button>
        <button type="button" data-debug="fetch">Run simulated fetch</button>
        <button type="button" data-debug="disable" class="caper-history-debug__danger">Disable debug</button>
      </div>
    `

    debugPanel.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }

      const debugAction = target.dataset.debug
      if (!debugAction) {
        return
      }

      if (debugAction === 'single') {
        pushSimulatedEntry({
          dateField: '04/01/2025',
          description: 'Debug lesson · single-day capture',
          grade: '3',
        })
      } else if (debugAction === 'range') {
        pushSimulatedEntry({
          dateField: '04/01/2025 - 04/03/2025',
          description: 'Debug lesson · three-day range capture',
          grade: '4',
        })
      } else if (debugAction === 'fetch') {
        simulateDebugFetch()
      } else if (debugAction === 'disable') {
        persistDebugPreference(false)
        const url = new URL(window.location.href)
        url.searchParams.set(DEBUG_QUERY_PARAM, '0')
        window.location.href = url.toString()
      }
    })

    document.body.appendChild(debugPanel)
  }

  function pushSimulatedEntry({ dateField, description, grade }) {
    const bodyString = buildSampleBody({ dateField, description, grade })
    finalizeCapture({
      url: absolutifyUrl(`${window.location.origin}${TARGET_PATH_FRAGMENT}`),
      method: 'POST',
      status: 200,
      bodyString,
    })
  }

  async function simulateDebugFetch() {
    const requestUrl = absolutifyUrl(`${window.location.origin}${TARGET_PATH_FRAGMENT}`)
    const bodyString = buildSampleBody({
      dateField: '04/10/2025',
      description: 'Debug lesson · simulated fetch call',
      grade: '5',
    })

    try {
      const response = await window.fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body: bodyString,
      })
      if (!response.ok) {
        console.warn('[CaperHistory] Simulated fetch returned status', response.status)
      }
    } catch (error) {
      console.warn('[CaperHistory] Simulated fetch failed (expected on debug hosts)', error)
      finalizeCapture({
        url: requestUrl,
        method: 'POST',
        status: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        bodyString,
      })
    }
  }

  function buildSampleBody({ dateField, description, grade }) {
    const params = new URLSearchParams()
    params.set('_token', 'debug-token')
    params.set('iip_lesson_record_date', dateField || '04/01/2025')
    params.set(
      'iip_lesson_record_description',
      description || 'Debug lesson captured by CAPER Lesson History Helper.'
    )
    params.set('iip_lesson_record_result', grade || '2')
    return params.toString()
  }

  async function deleteEntry(entryId) {
    historyCache = historyCache.filter((item) => item.id !== entryId)
    await gmSetValue(STORAGE_KEY, historyCache)
    renderHistory()
  }

  function renderHistory() {
    if (!entriesContainer || !emptyStateEl) {
      return
    }

    if (!historyCache.length) {
      entriesContainer.innerHTML = ''
      emptyStateEl.style.display = 'block'
      lastRender = ''
      return
    }

    const markup = historyCache.map((entry) => historyEntryTemplate(entry)).join('')

    if (markup === lastRender) {
      return
    }

    entriesContainer.innerHTML = markup
    emptyStateEl.style.display = 'none'
    lastRender = markup
  }

  function historyEntryTemplate(entry) {
    const dateField = toDisplayString(entry.payload['iip_lesson_record_date'])
    const description = toDisplayString(entry.payload['iip_lesson_record_description'])
    const grade = toDisplayString(entry.payload['iip_lesson_record_result'])
    const capturedAt = formatTimestamp(entry.capturedAt)
    const statusLabel = entry.status !== undefined && entry.status !== null ? `Status ${entry.status}` : 'Pending'
    const errorLabel = entry.error ? ` · Error: ${entry.error}` : ''

    return `
      <article class="caper-history-entry" data-entry-id="${entry.id}">
        <header class="caper-history-entry__header">
          <div class="caper-history-entry__title">
            <span class="caper-history-entry__label">Date</span>
            <span class="caper-history-entry__value">${escapeHtml(dateField)}</span>
          </div>
          <span class="caper-history-entry__grade">Grade ${escapeHtml(grade)}</span>
        </header>
        <section class="caper-history-entry__section">
          <span class="caper-history-entry__label">Description</span>
          <p class="caper-history-entry__description">${escapeHtml(description)}</p>
        </section>
        <footer class="caper-history-entry__footer">
          <span class="caper-history-entry__meta">Captured ${escapeHtml(capturedAt)} · ${escapeHtml(statusLabel + errorLabel)}</span>
          <div class="caper-history-entry__actions">
            <button type="button" data-action="fill">Fill form</button>
            <button type="button" data-action="paste">Paste data</button>
            <button type="button" data-action="copy">Copy payload</button>
            <button type="button" data-action="delete" class="caper-history-entry__delete">Remove</button>
          </div>
        </footer>
      </article>
    `
  }

  function fillFormFromEntry(entry, options = { paste: false }) {
    const payload = entry.payload || {}
    const description = payload['iip_lesson_record_description'] || ''
    const grade = payload['iip_lesson_record_result'] || ''
    const dateRaw = payload['iip_lesson_record_date'] || ''

    const form = detectLessonForm()
    if (!form) {
      console.warn('[CaperHistory] No matching lesson form found on the page')
    }

    const descriptionField = form?.querySelector(
      'textarea[name="iip_lesson_record_description"], textarea#iip_lesson_record_description'
    )
    const gradeInputs = form
      ? Array.from(
          form.querySelectorAll(
            'input[name="iip_lesson_record_result"], select[name="iip_lesson_record_result"]'
          )
        )
      : Array.from(
          document.querySelectorAll(
            'input[name="iip_lesson_record_result"], select[name="iip_lesson_record_result"]'
          )
        )
    const dateInputs = form
      ? Array.from(
          form.querySelectorAll(
            'input[name="iip_lesson_record_date"], input[name="iip_lesson_record_date[]"], input#evaluationDate'
          )
        )
      : Array.from(
          document.querySelectorAll(
            'input[name="iip_lesson_record_date"], input[name="iip_lesson_record_date[]"], input#evaluationDate'
          )
        )

    if (descriptionField) {
      applyValue(descriptionField, description, options)
    }

    if (gradeInputs.length) {
      applyGradeValue(gradeInputs, grade)
    }

    if (dateInputs.length) {
      const parts = splitDateRange(dateRaw)
      dateInputs.forEach((input, index) => {
        const part = index < parts.length ? parts[index] : parts[0]
        if (part) {
          applyValue(input, formatForInput(input, part), options)
        }
      })
    }

    if (!descriptionField && !gradeInputs.length && !dateInputs.length) {
      console.warn('[CaperHistory] Could not find matching form fields to fill')
    }
  }

  function detectLessonForm() {
    const form = document.querySelector('#form-create-iip-lesson-record, form[action*="lesson/store"], form[id*="lesson"][id*="record"]')
    if (form) {
      return form
    }

    const modal = document.querySelector('.modal-dialog .modal-content form')
    if (modal) {
      return modal
    }

    return document.body
  }

  function applyValue(element, value, options) {
    if (!element) {
      return
    }

    const { paste } = options
    const wasReadOnly = element.readOnly
    if (paste && wasReadOnly) {
      try {
        element.readOnly = false
      } catch (error) {
        // ignore
      }
    }

    if (paste) {
      dispatchPasteAttempt(element, value)
    } else {
      setNativeValue(element, value)
    }

    if (paste && typeof element.setRangeText === 'function') {
      element.focus()
      element.select()
      element.setRangeText(value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }

    if (!paste) {
      setNativeValue(element, value)
    }

    triggerExtraEvents(element)

    if (paste && wasReadOnly) {
      try {
        element.readOnly = true
      } catch (error) {
        // ignore
      }
    }
  }

  function dispatchPasteAttempt(element, value) {
    let prevented = false

    try {
      if (typeof ClipboardEvent === 'function') {
        const clipboardData = new DataTransfer()
        clipboardData.setData('text/plain', value)
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData,
        })
        prevented = !element.dispatchEvent(pasteEvent) || pasteEvent.defaultPrevented
      }
    } catch (error) {
      prevented = false
    }

    if (!prevented) {
      element.focus()
      try {
        if (typeof document.execCommand === 'function' && document.execCommand.length !== 0) {
          document.execCommand('selectAll', false, null)
          document.execCommand('insertText', false, value)
        } else {
          setNativeValue(element, value)
        }
      } catch (error) {
        setNativeValue(element, value)
      }
    }
  }

  function applyGradeValue(elements, grade) {
    if (!elements.length) {
      return
    }

    const normalizedGrade = String(grade)
    const radios = elements.filter((el) => el instanceof HTMLInputElement && el.type === 'radio')

    if (radios.length) {
      radios.forEach((radio) => {
        if (radio.value === normalizedGrade) {
          if (!radio.checked) {
            radio.click()
          } else {
            radio.dispatchEvent(new Event('change', { bubbles: true }))
          }
        } else {
          radio.checked = false
        }
      })
      return
    }

    const select = elements.find((el) => el instanceof HTMLSelectElement)
    if (select) {
      setNativeValue(select, normalizedGrade)
    }

    const inputs = elements.filter((el) => el instanceof HTMLInputElement && el.type !== 'radio')
    if (inputs.length) {
      inputs.forEach((input) => setNativeValue(input, normalizedGrade))
    }
  }

  function formatForInput(input, rawValue) {
    if (!input) {
      return rawValue
    }

    if (
      input.id === 'evaluationDate' ||
      input.classList.contains('datepicker-here') ||
      input.classList.contains('datepicker-keyup') ||
      input.type === 'text'
    ) {
      return rawValue
    }

    if (input.type === 'date') {
      return toIsoDate(rawValue)
    }

    return rawValue
  }

  async function copyPayload(text) {
    const payload = typeof text === 'string' ? text : ''
    if (!payload) {
      return
    }

    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(payload, 'text')
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(payload)
      } else {
        fallbackCopy(payload)
      }
    } catch (error) {
      fallbackCopy(payload)
    }
  }

  function fallbackCopy(text) {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    document.body.removeChild(textarea)
  }

  function triggerExtraEvents(element) {
    if (!element) {
      return
    }

    if (element.classList.contains('datepicker-keyup') || element.id === 'evaluationDate') {
      try {
        element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }))
      } catch (error) {
        element.dispatchEvent(new Event('keyup', { bubbles: true }))
      }
    }

    element.dispatchEvent(new Event('blur', { bubbles: true }))
  }

  function applyCollapsedState() {
    if (!panelRoot || !toggleButton) {
      return
    }

    panelRoot.classList.toggle('caper-history-panel--collapsed', panelCollapsed)
    const icon = panelCollapsed ? '+' : '−'
    const label = panelCollapsed ? 'Expand lesson history panel' : 'Collapse lesson history panel'
    toggleButton.setAttribute('aria-expanded', String(!panelCollapsed))
    toggleButton.setAttribute('aria-label', label)
    toggleButton.querySelector('.caper-history-toggle__icon').textContent = icon
  }

  function splitDateRange(raw) {
    if (!raw) {
      return []
    }
    return String(raw)
      .split('-')
      .map((part) => part.trim())
      .filter(Boolean)
  }

  function toIsoDate(raw) {
    if (!raw) {
      return ''
    }
    const pattern = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
    const match = String(raw).match(pattern)
    if (!match) {
      return raw
    }
    const [, mm, dd, yyyy] = match
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`
  }

  function toDisplayString(value) {
    if (value == null) {
      return ''
    }
    if (Array.isArray(value)) {
      return value.join(', ')
    }
    return String(value)
  }

  function formatTimestamp(isoString) {
    try {
      const date = new Date(isoString)
      return date.toLocaleString()
    } catch (error) {
      return isoString
    }
  }

  function setNativeValue(element, value) {
    if (!element) {
      return
    }

    const descriptor = Object.getOwnPropertyDescriptor(element.__proto__, 'value')
    const prototypeDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'value')
    const setter = (descriptor && descriptor.set) || (prototypeDescriptor && prototypeDescriptor.set)

    if (setter) {
      setter.call(element, value)
    } else {
      element.value = value
    }

    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
  }

  function injectStyles() {
    const styles = `
      .caper-history-panel {
        position: fixed !important;
        inset: 20px 20px auto auto !important;
        width: 280px;
        max-height: calc(100vh - 40px);
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px 16px;
        background: #ffffff;
        color: #1f2937;
        border-radius: 12px;
        border: 1px solid #dbeafe;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.15);
        z-index: 2147480000;
        font-family: "Prompt", "Kanit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        pointer-events: auto;
      }
      .caper-history-panel__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        padding-bottom: 8px;
        border-bottom: 1px solid #e2e8f0;
      }
      .caper-history-panel__heading {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .caper-history-panel__title {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
        color: #0f172a;
      }
      .caper-history-toggle {
        border: 1px solid #bfdbfe;
        border-radius: 999px;
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 0.9rem;
        font-weight: 600;
        cursor: pointer;
        background: #eff6ff;
        color: #1d4ed8;
        transition: background 0.2s ease, color 0.2s ease, transform 0.2s ease;
      }
      .caper-history-toggle:hover {
        background: #dbeafe;
        color: #1e40af;
        transform: translateY(-1px);
      }
      .caper-history-toggle__icon {
        pointer-events: none;
        line-height: 1;
      }
      .caper-history-clear {
        padding: 4px 12px;
        border-radius: 999px;
        border: 1px solid #cbd5f5;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
        background: #f8fafc;
        color: #1e3a8a;
        transition: background 0.2s ease, transform 0.2s ease;
      }
      .caper-history-clear:hover {
        background: #e0f2fe;
        transform: translateY(-1px);
      }
      .caper-history-panel__body {
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .caper-history-empty {
        margin: 0;
        text-align: center;
        color: #94a3b8;
      }
      .caper-history-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .caper-history-panel--collapsed {
        width: 220px;
        padding: 10px 12px;
        gap: 6px;
      }
      .caper-history-panel--collapsed .caper-history-panel__body {
        display: none;
      }
      .caper-history-panel--collapsed .caper-history-clear {
        display: none;
      }
      .caper-history-panel--collapsed .caper-history-panel__heading {
        width: 100%;
        justify-content: space-between;
      }
      .caper-history-panel--collapsed .caper-history-panel__header {
        padding-bottom: 0;
        border-bottom: none;
      }
      .caper-history-panel--collapsed .caper-history-panel__title {
        font-size: 0.85rem;
      }
      .caper-history-entry {
        background: #f8fbff;
        border-radius: 10px;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        border: 1px solid #dbeafe;
        box-shadow: 0 8px 18px rgba(15, 23, 42, 0.08);
      }
      .caper-history-entry__header {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 8px;
        padding-bottom: 4px;
        border-bottom: 1px solid #e2e8f0;
      }
      .caper-history-entry__title {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .caper-history-entry__label {
        font-size: 0.7rem;
        color: #64748b;
      }
      .caper-history-entry__value {
        font-size: 0.9rem;
        font-weight: 600;
        color: #0f172a;
        line-height: 1.3;
      }
      .caper-history-entry__grade {
        font-size: 0.8rem;
        font-weight: 600;
        background: #e0f2fe;
        color: #1d4ed8;
        padding: 2px 10px;
        border-radius: 999px;
        border: 1px solid #bfdbfe;
      }
      .caper-history-entry__description {
        margin: 0;
        font-size: 0.82rem;
        line-height: 1.45;
        color: #475569;
        white-space: pre-wrap;
      }
      .caper-history-entry__footer {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding-top: 6px;
        border-top: 1px solid #e2e8f0;
      }
      .caper-history-entry__meta {
        font-size: 0.68rem;
        color: #94a3b8;
      }
      .caper-history-entry__actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .caper-history-entry__actions button {
        flex: 1 1 48%;
        border: 1px solid #cbd5f5;
        border-radius: 6px;
        padding: 6px 10px;
        font-size: 0.72rem;
        font-weight: 500;
        cursor: pointer;
        background: #2563eb;
        color: #ffffff;
        transition: background 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
      }
      .caper-history-entry__actions button:hover {
        background: #1d4ed8;
        box-shadow: 0 6px 12px rgba(37, 99, 235, 0.25);
        transform: translateY(-1px);
      }
      .caper-history-entry__actions .caper-history-entry__delete {
        background: #f87171;
        border-color: #ef4444;
        color: #ffffff;
      }
      .caper-history-entry__actions .caper-history-entry__delete:hover {
        background: #ef4444;
        box-shadow: 0 6px 12px rgba(239, 68, 68, 0.25);
      }
      .caper-history-entry__actions [data-action="paste"] {
        background: #0ea5e9;
        border-color: #0284c7;
        color: #ffffff;
      }
      .caper-history-entry__actions [data-action="paste"]:hover {
        background: #0284c7;
        box-shadow: 0 6px 12px rgba(14, 165, 233, 0.25);
      }
      .caper-history-debug {
        position: fixed !important;
        inset: auto auto 20px 20px !important;
        width: 260px;
        padding: 14px 16px;
        border-radius: 12px;
        background: #ffffff;
        color: #1f2937;
        border: 1px solid #dbeafe;
        box-shadow: 0 12px 30px rgba(15, 23, 42, 0.15);
        display: flex;
        flex-direction: column;
        gap: 10px;
        font-family: "Prompt", "Kanit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        z-index: 2147480000;
        pointer-events: auto;
      }
      @media (max-width: 900px) {
        .caper-history-panel {
          inset: 12px !important;
          width: auto;
          max-height: calc(100vh - 24px);
        }
        .caper-history-entry__actions button {
          flex: 1 1 100%;
        }
        .caper-history-debug {
          inset: auto 12px 12px 12px !important;
          width: auto;
        }
      }
    `

    if (typeof GM_addStyle === 'function') {
      GM_addStyle(styles)
    } else {
      const styleEl = document.createElement('style')
      styleEl.textContent = styles
      document.head.appendChild(styleEl)
    }
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function absolutifyUrl(url) {
    try {
      return new URL(url, window.location.href).toString()
    } catch (error) {
      return url
    }
  }

  function onDocumentReady(callback) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', callback, { once: true })
    } else {
      callback()
    }
  }

  async function gmGetValue(key, defaultValue) {
    if (typeof GM_getValue === 'function') {
      const value = GM_getValue(key, defaultValue)
      if (value && typeof value.then === 'function') {
        return await value
      }
      return value
    }
    if (typeof GM !== 'undefined' && typeof GM.getValue === 'function') {
      return await GM.getValue(key, defaultValue)
    }
    return defaultValue
  }

  async function gmSetValue(key, value) {
    if (typeof GM_setValue === 'function') {
      const result = GM_setValue(key, value)
      if (result && typeof result.then === 'function') {
        return await result
      }
      return result
    }
    if (typeof GM !== 'undefined' && typeof GM.setValue === 'function') {
      return await GM.setValue(key, value)
    }
    return undefined
  }

  async function resolveMaybePromise(value) {
    if (value && typeof value.then === 'function') {
      return await value
    }
    return value
  }
})()
