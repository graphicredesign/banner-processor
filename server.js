import express from 'express'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs-extra'
import path from 'path'
import { fileURLToPath } from 'url'
import { processWebflowZip } from './processor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json())

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Web to Banner Processor running' })
})

// Security — verify request comes from your Next.js app
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

  // Respond immediately so the request doesn't time out
  res.json({ success: true, message: 'Processing started' })

  try {
    // Update status to processing
    await supabase.from('projects')
      .update({ status: 'processing' })
      .eq('id', projectId)

    // Download ZIP from Supabase storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from('input-zips')
      .download(filePath)

    if (downloadError) throw downloadError

    // Save to temp folder
    const tmpDir = path.join(__dirname, 'tmp', projectId)
    await fs.ensureDir(tmpDir)
    const zipPath = path.join(tmpDir, 'input.zip')
    const buffer = Buffer.from(await fileData.arrayBuffer())
    await fs.writeFile(zipPath, buffer)

    // Process the banner
    const outputZipPath = await processWebflowZip(zipPath, tmpDir)

    // Upload output ZIP to Supabase storage
    const outputStoragePath = `${userId}/${projectId}-output.zip`
    const outputBuffer = await fs.readFile(outputZipPath)

    const { error: uploadError } = await supabase.storage
      .from('output-zips')
      .upload(outputStoragePath, outputBuffer, {
        contentType: 'application/zip',
        upsert: true
      })

    if (uploadError) throw uploadError

    // Update project as complete
    await supabase.from('projects')
      .update({
        status: 'complete',
        output_zip_path: outputStoragePath
      })
      .eq('id', projectId)

    // Clean up temp files
    await fs.remove(tmpDir)

  } catch (err) {
    console.error('Processing error:', err)
    await supabase.from('projects')
      .update({ status: 'error' })
      .eq('id', projectId)
  }
})

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`Banner processor running on port ${PORT}`)
})