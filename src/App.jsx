import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'

const SUPPORTED_FORMATS = [
  'qr_code',
  'aztec',
  'data_matrix',
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_39',
  'code_93',
  'code_128',
  'itf',
  'codabar',
  'pdf417',
]
const LOW_LIGHT_HINT_DELAY_MS = 10000
const EMPTY_DETECTIONS_BEFORE_INVERSION = 3
const INVERTED_DETECTION_COOLDOWN_MS = 1200
const MAX_INVERTED_FRAME_DIMENSION = 960

const LABELS = {
  qr_code: 'QR Code',
  aztec: 'Aztec',
  data_matrix: 'Data Matrix',
  ean_13: 'EAN-13',
  ean_8: 'EAN-8',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
  code_39: 'Code 39',
  code_93: 'Code 93',
  code_128: 'Code 128',
  itf: 'ITF',
  codabar: 'Codabar',
  pdf417: 'PDF417',
  unknown: 'Unknown',
}

const ENCODING_OPTIONS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'iso-8859-1', label: 'ISO-8859-1 (Latin-1)' },
  { value: 'windows-1252', label: 'Windows-1252' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'gb18030', label: 'GB18030' },
]
const INTERPRETATION_OPTIONS = [
  { value: 'text', label: 'Text' },
  { value: 'numeric', label: 'Numeric' },
  { value: 'alphanumeric', label: 'Alphanumeric' },
  { value: 'binary', label: 'Binary / Hex' },
]
const QR_ALPHANUMERIC_SET = /^[0-9A-Z $%*+\-./:]*$/

const formatLabel = (format = 'unknown') => LABELS[format] || format
const formatSourceLabel = (source) => (source === 'gallery' ? 'Image/Gallery' : 'Camera')
const getFormatEncoding = (encodingByFormat, format) => encodingByFormat[format] || 'utf-8'
const getFormatInterpretation = (interpretationByFormat, format) =>
  interpretationByFormat[format] || 'text'

const decodeWithEncoding = (value, encoding) => {
  if (!value || encoding === 'utf-8') {
    return value
  }

  try {
    const codeUnits = Array.from(value, (char) => char.charCodeAt(0))
    if (codeUnits.some((unit) => unit > 0xff)) {
      return value
    }
    const bytes = Uint8Array.from(codeUnits)
    return new TextDecoder(encoding).decode(bytes)
  } catch {
    return value
  }
}

const getRelativeTime = (start, detectedAt) => {
  const delta = Math.max(0, Math.floor((detectedAt - start) / 1000))
  const minutes = Math.floor(delta / 60)
  const seconds = delta % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

const isValidUrl = (value) => {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))
const getBytesFromText = (value) => {
  if (!value) {
    return { bytes: new Uint8Array(), source: 'Empty value' }
  }
  const codeUnits = Array.from(value, (char) => char.charCodeAt(0))
  if (codeUnits.every((unit) => unit <= 0xff)) {
    return {
      bytes: Uint8Array.from(codeUnits),
      source: 'Code point bytes from decoded text',
    }
  }
  return {
    bytes: new TextEncoder().encode(value),
    source: 'UTF-8 bytes from decoded text',
  }
}
const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ')
const toBinary = (bytes) => Array.from(bytes, (byte) => byte.toString(2).padStart(8, '0')).join(' ')
const toNumeric = (bytes) => {
  if (bytes.length === 0) {
    return '0'
  }
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return BigInt(`0x${hex}`).toString(10)
}
const toAlphanumeric = (value) => {
  const upper = value.toUpperCase()
  return Array.from(upper, (char) => (QR_ALPHANUMERIC_SET.test(char) ? char : '·')).join('')
}

const createEntryId = () =>
  (typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`)

function App() {
  const videoRef = useRef(null)
  const fileInputRef = useRef(null)
  const streamRef = useRef(null)
  const trackRef = useRef(null)
  const detectorRef = useRef(null)
  const detectCodesRef = useRef(async () => {})
  const rafRef = useRef(null)
  const scanningRef = useRef(false)
  const seenValuesRef = useRef(new Set())
  const toastTimerRef = useRef(null)
  const hasSuccessfulScanRef = useRef(false)
  const lowLightTimerRef = useRef(null)
  const pinchStateRef = useRef({ distance: null, zoom: 1 })
  const invertedCanvasRef = useRef(null)
  const invertedContextRef = useRef(null)
  const emptyDetectionsRef = useRef(0)
  const invertedCooldownUntilRef = useRef(0)

  const [permission, setPermission] = useState('prompt')
  const [error, setError] = useState('')
  const [codes, setCodes] = useState([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [selectedCode, setSelectedCode] = useState(null)
  const [viewerCode, setViewerCode] = useState(null)
  const [toast, setToast] = useState('')
  const [torchOn, setTorchOn] = useState(false)
  const [torchSupported, setTorchSupported] = useState(false)
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1, step: 0.1 })
  const [zoom, setZoom] = useState(1)
  const [sessionStart, setSessionStart] = useState(() => Date.now())
  const [showTorchHint, setShowTorchHint] = useState(false)
  const [focusMessage, setFocusMessage] = useState('')
  const [encodingByFormat, setEncodingByFormat] = useState({})
  const [interpretationByFormat, setInterpretationByFormat] = useState({})
  const [scanningImage, setScanningImage] = useState(false)

  const canUseScanner = typeof window !== 'undefined' && 'BarcodeDetector' in window

  const stopScanner = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (lowLightTimerRef.current) {
      clearTimeout(lowLightTimerRef.current)
      lowLightTimerRef.current = null
    }
    scanningRef.current = false
    setTorchOn(false)
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    trackRef.current = null
    invertedCanvasRef.current = null
    invertedContextRef.current = null
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }, [])

  const showToast = useCallback((message) => {
    setToast(message)
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 1500)
  }, [])

  const triggerFeedback = useCallback(() => {
    if ('vibrate' in navigator) {
      navigator.vibrate(20)
    }
    try {
      const context = new window.AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.type = 'sine'
      oscillator.frequency.value = 880
      gain.gain.value = 0.02
      oscillator.start()
      oscillator.stop(context.currentTime + 0.08)
      oscillator.onended = () => {
        context.close().catch(() => {})
      }
    } catch {
      // Ignore playback errors and continue scanning.
    }
  }, [])

  const addDetectedCode = useCallback(
    (code, readDetails) => {
      if (!code.rawValue || seenValuesRef.current.has(code.rawValue)) {
        return null
      }

      const entry = {
        id: createEntryId(),
        value: code.rawValue,
        format: code.format || 'unknown',
        detectedAt: Date.now(),
        source: readDetails.source,
        readMode: readDetails.readMode,
        fileName: readDetails.fileName || '',
      }
      seenValuesRef.current.add(entry.value)
      hasSuccessfulScanRef.current = true
      setShowTorchHint(false)
      setCodes((current) => [entry, ...current])
      setSelectedCode(entry)
      triggerFeedback()
      return entry
    },
    [triggerFeedback],
  )

  const detectInvertedImageCodes = useCallback(async (bitmap, detector) => {
    const width = bitmap.width || bitmap.videoWidth
    const height = bitmap.height || bitmap.videoHeight
    if (!width || !height) {
      return []
    }

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      return []
    }
    context.drawImage(bitmap, 0, 0, width, height)
    const frame = context.getImageData(0, 0, width, height)
    const { data } = frame
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 255 - data[index]
      data[index + 1] = 255 - data[index + 1]
      data[index + 2] = 255 - data[index + 2]
    }
    context.putImageData(frame, 0, 0)

    try {
      return await detector.detect(canvas)
    } catch {
      return []
    }
  }, [])

  const applyZoom = useCallback(
    async (nextZoom) => {
      if (!trackRef.current) return
      const clamped = clamp(nextZoom, zoomRange.min, zoomRange.max)
      try {
        await trackRef.current.applyConstraints({ advanced: [{ zoom: clamped }] })
        setZoom(clamped)
      } catch {
        setFocusMessage('Zoom is not supported on this camera.')
      }
    },
    [zoomRange.max, zoomRange.min],
  )

  const detectInvertedCodes = useCallback(async () => {
    const video = videoRef.current
    if (!video || !detectorRef.current) {
      return []
    }

    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) {
      return []
    }
    const scale = Math.min(1, MAX_INVERTED_FRAME_DIMENSION / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))

    if (!invertedCanvasRef.current) {
      invertedCanvasRef.current = document.createElement('canvas')
      invertedContextRef.current = invertedCanvasRef.current.getContext('2d', {
        willReadFrequently: true,
      })
    }

    const canvas = invertedCanvasRef.current
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
    }

    const context = invertedContextRef.current
    if (!context) {
      return []
    }

    context.drawImage(video, 0, 0, targetWidth, targetHeight)
    const frame = context.getImageData(0, 0, targetWidth, targetHeight)
    const { data } = frame
    for (let index = 0; index < data.length; index += 4) {
      data[index] = 255 - data[index]
      data[index + 1] = 255 - data[index + 1]
      data[index + 2] = 255 - data[index + 2]
    }
    context.putImageData(frame, 0, 0)

    try {
      return await detectorRef.current.detect(canvas)
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    detectCodesRef.current = async () => {
      if (!videoRef.current || !detectorRef.current || scanningRef.current) return

      scanningRef.current = true
      try {
        let readMode = 'normal'
        let detected = await detectorRef.current.detect(videoRef.current)
        if (detected.length === 0) {
          emptyDetectionsRef.current += 1
          if (
            emptyDetectionsRef.current >= EMPTY_DETECTIONS_BEFORE_INVERSION &&
            Date.now() >= invertedCooldownUntilRef.current
          ) {
            detected = await detectInvertedCodes()
            if (detected.length > 0) {
              emptyDetectionsRef.current = 0
              invertedCooldownUntilRef.current = 0
              readMode = 'inverted'
            } else {
              invertedCooldownUntilRef.current = Date.now() + INVERTED_DETECTION_COOLDOWN_MS
            }
          }
        } else {
          emptyDetectionsRef.current = 0
          invertedCooldownUntilRef.current = 0
        }
        for (const code of detected) {
          if (addDetectedCode(code, { source: 'camera', readMode })) {
            break
          }
        }
      } catch {
        setError('Scanning failed on this device.')
      } finally {
        scanningRef.current = false
        rafRef.current = requestAnimationFrame(() => {
          void detectCodesRef.current()
        })
      }
    }
  }, [addDetectedCode, detectInvertedCodes])

  const startScanner = useCallback(async () => {
    if (!canUseScanner) {
      setError('Barcode scanning is not supported by this browser.')
      return
    }

    stopScanner()
    setError('')

    try {
      const detector = new window.BarcodeDetector({ formats: SUPPORTED_FORMATS })
      detectorRef.current = detector

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })

      streamRef.current = stream
      const [videoTrack] = stream.getVideoTracks()

      if (!videoTrack) {
        setError('No camera is available on this device.')
        stopScanner()
        return
      }

      const capabilities = videoTrack.getCapabilities?.() || {}
      const supportsTorch = Boolean(capabilities.torch)
      trackRef.current = videoTrack
      setTorchSupported(supportsTorch)

      if (capabilities.zoom) {
        const nextRange = {
          min: capabilities.zoom.min,
          max: capabilities.zoom.max,
          step: capabilities.zoom.step || 0.1,
        }
        setZoomRange(nextRange)
        setZoom(nextRange.min)
      }

      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }

      setPermission('granted')

      if (supportsTorch && !hasSuccessfulScanRef.current) {
        lowLightTimerRef.current = setTimeout(() => {
          if (!hasSuccessfulScanRef.current) {
            setShowTorchHint(true)
          }
        }, LOW_LIGHT_HINT_DELAY_MS)
      }

      rafRef.current = requestAnimationFrame(() => {
        void detectCodesRef.current()
      })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermission('denied')
        setError('Camera access is required to scan codes.')
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setError('No camera is available on this device.')
      } else {
        setError('Unable to start the camera scanner.')
      }
    }
  }, [canUseScanner, stopScanner])

  const scanFromImage = useCallback(
    async (file) => {
      if (!file) {
        return
      }
      if (!canUseScanner) {
        setError('Barcode scanning is not supported by this browser.')
        return
      }

      setError('')
      setScanningImage(true)
      try {
        const detector =
          detectorRef.current || new window.BarcodeDetector({ formats: SUPPORTED_FORMATS })
        detectorRef.current = detector
        const bitmap = await createImageBitmap(file)
        let readMode = 'normal'
        let detected = await detector.detect(bitmap)
        if (detected.length === 0) {
          detected = await detectInvertedImageCodes(bitmap, detector)
          if (detected.length > 0) {
            readMode = 'inverted'
          }
        }

        bitmap.close?.()

        let added = 0
        for (const code of detected) {
          if (
            addDetectedCode(code, {
              source: 'gallery',
              readMode,
              fileName: file.name,
            })
          ) {
            added += 1
          }
        }

        if (added === 0) {
          setError('No new code was found in the selected image.')
          return
        }
        showToast(added > 1 ? `Added ${added} codes from image.` : 'Added code from image.')
      } catch {
        setError('Unable to decode the selected image.')
      } finally {
        setScanningImage(false)
      }
    },
    [addDetectedCode, canUseScanner, detectInvertedImageCodes, showToast],
  )

  useEffect(() => {
    const bootstrap = setTimeout(() => {
      void startScanner()
    }, 0)

    return () => {
      clearTimeout(bootstrap)
      stopScanner()
      window.clearTimeout(toastTimerRef.current)
    }
  }, [startScanner, stopScanner])

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        stopScanner()
        return
      }
      void startScanner()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => document.removeEventListener('visibilitychange', onVisibilityChange)
  }, [startScanner, stopScanner])

  const toggleTorch = async () => {
    if (!trackRef.current || !torchSupported) {
      return
    }

    const nextState = !torchOn
    try {
      await trackRef.current.applyConstraints({ advanced: [{ torch: nextState }] })
      setTorchOn(nextState)
      setShowTorchHint(false)
    } catch {
      setFocusMessage('Torch is not supported on this camera.')
    }
  }

  const onTapToFocus = async (event) => {
    if (!trackRef.current) return

    const capabilities = trackRef.current.getCapabilities?.() || {}
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width
    const y = (event.clientY - bounds.top) / bounds.height

    if (!capabilities.pointsOfInterest) {
      setFocusMessage('Tap-to-focus is not available on this camera.')
      return
    }

    try {
      await trackRef.current.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x, y }], focusMode: 'single-shot' }],
      })
      setFocusMessage('Focus updated.')
    } catch {
      setFocusMessage('Tap-to-focus is not available on this camera.')
    }
  }

  const onTouchMove = (event) => {
    if (event.touches.length !== 2 || zoomRange.max <= zoomRange.min) {
      pinchStateRef.current.distance = null
      return
    }

    const [touchA, touchB] = event.touches
    const distance = Math.hypot(
      touchA.clientX - touchB.clientX,
      touchA.clientY - touchB.clientY,
    )

    if (!pinchStateRef.current.distance) {
      pinchStateRef.current.distance = distance
      pinchStateRef.current.zoom = zoom
      return
    }

    const delta = distance / pinchStateRef.current.distance
    const nextZoom = pinchStateRef.current.zoom * delta
    void applyZoom(nextZoom)
  }

  const resetSession = () => {
    if (!window.confirm('Clear all scanned codes from this session?')) {
      return
    }
    setCodes([])
    seenValuesRef.current = new Set()
    setSessionStart(Date.now())
    hasSuccessfulScanRef.current = false
    setShowTorchHint(false)
  }

  const getCodeText = useCallback(
    (code) => decodeWithEncoding(code.value, getFormatEncoding(encodingByFormat, code.format)),
    [encodingByFormat],
  )
  const getCodeInterpretation = useCallback(
    (code) => {
      const encoding = getFormatEncoding(encodingByFormat, code.format)
      const interpretation = getFormatInterpretation(interpretationByFormat, code.format)
      const decodedText = decodeWithEncoding(code.value, encoding)
      const { bytes, source: byteSource } = getBytesFromText(decodedText)
      if (interpretation === 'numeric') {
        return {
          value: toNumeric(bytes),
          encoding,
          interpretation,
          byteSource,
          byteLength: bytes.length,
        }
      }
      if (interpretation === 'alphanumeric') {
        return {
          value: toAlphanumeric(decodedText),
          encoding,
          interpretation,
          byteSource,
          byteLength: bytes.length,
        }
      }
      if (interpretation === 'binary') {
        return {
          value: `HEX: ${toHex(bytes) || '(empty)'}\nBIN: ${toBinary(bytes) || '(empty)'}`,
          encoding,
          interpretation,
          byteSource,
          byteLength: bytes.length,
        }
      }
      return {
        value: decodedText,
        encoding,
        interpretation,
        byteSource,
        byteLength: bytes.length,
      }
    },
    [encodingByFormat, interpretationByFormat],
  )

  const selectedCodeText = selectedCode ? getCodeText(selectedCode) : ''
  const viewerInterpretation = viewerCode ? getCodeInterpretation(viewerCode) : null

  const openUrl = () => {
    if (!selectedCode || !isValidUrl(selectedCodeText)) {
      return
    }
    window.open(selectedCodeText, '_blank', 'noopener,noreferrer')
  }

  const shareCode = async () => {
    if (!selectedCode) return

    try {
      if (navigator.share) {
        await navigator.share({ text: selectedCodeText })
      } else {
        await navigator.clipboard.writeText(selectedCodeText)
        showToast('Copied to clipboard for sharing.')
      }
    } catch {
      showToast('Unable to share this code.')
    }
  }

  const copyCode = async () => {
    if (!selectedCode) return
    try {
      await navigator.clipboard.writeText(selectedCodeText)
      showToast('Copied')
    } catch {
      showToast('Copy failed')
    }
  }

  return (
    <main className="scanner-page">
      <header className="top-bar">
        <h1>QRe</h1>
        <div className="top-actions">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={scanningImage}
          >
            {scanningImage ? 'Reading image…' : 'Scan image'}
          </button>
          <button type="button" onClick={() => setHistoryOpen((open) => !open)}>
            {historyOpen ? 'Hide list' : 'Session list'}
          </button>
          <button type="button" onClick={toggleTorch} disabled={!torchSupported}>
            {torchOn ? 'Torch on' : 'Torch off'}
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="visually-hidden"
        onChange={(event) => {
          const [file] = event.target.files || []
          void scanFromImage(file)
          event.target.value = ''
        }}
      />

      <section
        className="viewfinder"
        onClick={onTapToFocus}
        onTouchMove={onTouchMove}
        onTouchEnd={() => {
          pinchStateRef.current.distance = null
        }}
      >
        <video ref={videoRef} muted playsInline aria-label="Camera viewfinder" />
        <div className="reticle" aria-hidden="true" />

        {permission === 'denied' && (
          <div className="overlay-card">
            <h2>Camera permission needed</h2>
            <p>Allow camera access in your browser settings to scan QR and barcodes.</p>
            <button type="button" onClick={startScanner}>
              Retry camera access
            </button>
          </div>
        )}

        {error && permission !== 'denied' && (
          <div className="overlay-card">
            <h2>Scanner unavailable</h2>
            <p>{error}</p>
            <button type="button" onClick={startScanner}>
              Retry
            </button>
          </div>
        )}

        {showTorchHint && !torchOn && (
          <div className="hint">Low light detected? Try enabling the torch.</div>
        )}

        {focusMessage && <div className="hint secondary">{focusMessage}</div>}

        {zoomRange.max > zoomRange.min && (
          <div className="zoom-controls" role="group" aria-label="Zoom controls">
            <button type="button" onClick={() => void applyZoom(zoom - zoomRange.step)}>
              -
            </button>
            <span>{zoom.toFixed(1)}x</span>
            <button type="button" onClick={() => void applyZoom(zoom + zoomRange.step)}>
              +
            </button>
          </div>
        )}
      </section>

      <aside className={`history ${historyOpen ? 'open' : ''}`}>
        <div className="history-header">
          <h2>Session history</h2>
          <button type="button" onClick={resetSession} disabled={codes.length === 0}>
            Clear
          </button>
        </div>

        {codes.length === 0 ? (
          <p className="empty">No scans yet.</p>
        ) : (
          <ul>
            {codes.map((code) => (
              <li key={code.id}>
                <button type="button" onClick={() => setSelectedCode(code)}>
                  <span>{formatLabel(code.format)}</span>
                  <strong>{code.value}</strong>
                  <small>{getRelativeTime(sessionStart, code.detectedAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      {selectedCode && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="Code actions">
          <div className="sheet-card">
            <h3>{formatLabel(selectedCode.format)}</h3>
            <p>{selectedCodeText}</p>
            <div className="sheet-actions">
              <button type="button" onClick={() => setViewerCode(selectedCode)}>
                View
              </button>
              <button
                type="button"
                onClick={openUrl}
                disabled={!isValidUrl(selectedCodeText)}
              >
                Open URL
              </button>
              <button type="button" onClick={() => void shareCode()}>
                Share
              </button>
              <button type="button" onClick={() => void copyCode()}>
                Copy
              </button>
              <button type="button" onClick={() => setSelectedCode(null)}>
                Close
              </button>
            </div>
          </div>
        </section>
      )}

      {viewerCode && (
        <section className="sheet" role="dialog" aria-modal="true" aria-label="Raw code content">
          <div className="sheet-card">
            <h3>Decoded view</h3>
            <div className="viewer-controls">
              <label className="encoding-picker">
                <span>Encoding</span>
                <select
                  value={getFormatEncoding(encodingByFormat, viewerCode.format)}
                  onChange={(event) => {
                    const nextEncoding = event.target.value
                    setEncodingByFormat((current) => ({
                      ...current,
                      [viewerCode.format]: nextEncoding,
                    }))
                  }}
                >
                  {ENCODING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="encoding-picker">
                <span>Interpretation</span>
                <select
                  value={getFormatInterpretation(interpretationByFormat, viewerCode.format)}
                  onChange={(event) => {
                    const nextInterpretation = event.target.value
                    setInterpretationByFormat((current) => ({
                      ...current,
                      [viewerCode.format]: nextInterpretation,
                    }))
                  }}
                >
                  {INTERPRETATION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <small className="encoding-note">
              Decoding and interpretation are applied to this already scanned value.
            </small>
            <dl className="parameter-list">
              <div>
                <dt>Read source</dt>
                <dd>{formatSourceLabel(viewerCode.source)}</dd>
              </div>
              <div>
                <dt>Read mode</dt>
                <dd>{viewerCode.readMode || 'normal'}</dd>
              </div>
              <div>
                <dt>Reader</dt>
                <dd>BarcodeDetector ({SUPPORTED_FORMATS.length} formats)</dd>
              </div>
              <div>
                <dt>Input format</dt>
                <dd>{formatLabel(viewerCode.format)}</dd>
              </div>
              {viewerCode.fileName && (
                <div>
                  <dt>Image file</dt>
                  <dd>{viewerCode.fileName}</dd>
                </div>
              )}
              <div>
                <dt>Encoding</dt>
                <dd>{viewerInterpretation?.encoding || 'utf-8'}</dd>
              </div>
              <div>
                <dt>Interpretation</dt>
                <dd>{viewerInterpretation?.interpretation || 'text'}</dd>
              </div>
              <div>
                <dt>Byte source</dt>
                <dd>{viewerInterpretation?.byteSource || 'N/A'}</dd>
              </div>
              <div>
                <dt>Byte length</dt>
                <dd>{viewerInterpretation?.byteLength ?? 0}</dd>
              </div>
            </dl>
            <pre className="decoded-output">{viewerInterpretation?.value || ''}</pre>
            <button type="button" onClick={() => setViewerCode(null)}>
              Close
            </button>
          </div>
        </section>
      )}

      {toast && <div className="toast">{toast}</div>}
    </main>
  )
}

export default App
