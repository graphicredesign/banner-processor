import express from 'express'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import { processWebflowZip } from './processor.js'
import unzipper from 'unzipper'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Store active previews in memory with expiry
const activePreviews = new Map()

// Clean up expired previews every 5 minutes
setInterval(async () => {
  const now = Date.now()
  for (const [projectId, preview] of activePreviews.entries()) {
    if (now > preview.expiresAt) {
      await fs.remove(preview.dir).catch(() => {})
      activePreviews.delete(projectId)
      console.log(`Cleaned up preview for ${projectId}`)
    }
  }
}, 5 * 60 * 1000)

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Web to Banner Processor running' })
})

// Security middleware
function verifySecret(req, res, next) {
  const secret = req.headers['x-processor-secret']
  if (secret !== process.env.PROCESSOR_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// Main processing endpoint
app.post('/process', verifySecret, async (req, res) => {
  const { projectId, filePath, userId } = req.body

  if (!projectId || !filePath || !userId) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  res.json({ success: true, message: 'Processing started' })

  try {
    await supabase.from('projects')
      .update({ status: 'processing' })
      .eq('id', projectId)

    const { data: fileData, error: downloadError } = await supabase.storage
      .from('input-zips')
      .download(filePath)
    if (downloadError) throw downloadError

    const tmpDir = path.join(__dirname, 'tmp', projectId)
    await fs.ensureDir(tmpDir)
    const zipPath = path.join(tmpDir, 'input.zip')
    const buffer = Buffer.from(await fileData.arrayBuffer())
    await fs.writeFile(zipPath, buffer)

    const outputZipPath = await processWebflowZip(zipPath, tmpDir)

    const outputStoragePath = `${userId}/${projectId}-output.zip`
    const outputBuffer = await fs.readFile(outputZipPath)

    const { error: uploadError } = await supabase.storage
      .from('output-zips')
      .upload(outputStoragePath, outputBuffer, {
        contentType: 'application/zip',
        upsert: true
      })
    if (uploadError) throw uploadError

    await supabase.from('projects')
      .update({ status: 'complete', output_zip_path: outputStoragePath })
      .eq('id', projectId)

    await fs.remove(tmpDir)

  } catch (err) {
    console.error('Processing error:', err)
    await supabase.from('projects')
      .update({ status: 'error' })
      .eq('id', projectId)
  }
})

// Preview endpoint
app.post('/preview', verifySecret, async (req, res) => {
  const { projectId, outputZipPath } = req.body

  if (!projectId || !outputZipPath) {
    return res.status(400).json({ error: 'Missing required fields' })
  }

  try {
    // Check if preview already exists and is still valid
    if (activePreviews.has(projectId)) {
      const existing = activePreviews.get(projectId)
      if (Date.now() < existing.expiresAt) {
        return res.json({ previewUrl: existing.url })
      }
      // Expired — clean up and recreate
      await fs.remove(existing.dir).catch(() => {})
      activePreviews.delete(projectId)
    }

    // Download output ZIP from Supabase
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('output-zips')
      .download(outputZipPath)
    if (downloadError) throw downloadError

    // Extract ZIP to preview folder
    const previewDir = path.join(__dirname, 'previews', projectId)
    await fs.ensureDir(previewDir)

    const buffer = Buffer.from(await fileData.arrayBuffer())
    const zipPath = path.join(previewDir, 'output.zip')
    await fs.writeFile(zipPath, buffer)

    // Extract the ZIP
    await fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: previewDir }))
      .promise()

    await fs.remove(zipPath)

    // Find the first index.html
    const htmlFiles = await fs.readdir(previewDir)
    const sizes = htmlFiles.filter(f => f.includes('x') && !f.includes('.'))

    // Store preview with 10 minute expiry
    const expiresAt = Date.now() + 10 * 60 * 1000
    const serviceUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:3001`
    const previewUrl = `${serviceUrl}/preview/${projectId}`

    activePreviews.set(projectId, { dir: previewDir, expiresAt, url: previewUrl })

    res.json({ previewUrl, sizes })

  } catch (err) {
    console.error('Preview error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Serve preview files
app.use('/preview/:projectId', (req, res, next) => {
  const { projectId } = req.params
  const preview = activePreviews.get(projectId)

  if (!preview || Date.now() > preview.expiresAt) {
    return res.status(404).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>Preview Expired</h2>
        <p>This preview has expired. Go back to your dashboard and click Preview again.</p>
      </body></html>
    `)
  }

  express.static(preview.dir)(req, res, next)
})

app.get('/preview/:projectId', (req, res, next) => {
  const { projectId } = req.params
  const preview = activePreviews.get(projectId)

  if (!preview || Date.now() > preview.expiresAt) {
    return res.status(404).send('Preview expired')
  }

  // Find first size folder and serve its index.html
  fs.readdir(preview.dir).then(files => {
    const sizeFolder = files.find(f => f.match(/^\d+x\d+$/))
    if (sizeFolder) {
      res.sendFile(path.join(preview.dir, sizeFolder, 'index.html'))
    } else {
      res.sendFile(path.join(preview.dir, 'index.html'))
    }
  }).catch(() => res.status(500).send('Error loading preview'))
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Banner processor running on port ${PORT}`)
})