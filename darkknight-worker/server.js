require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
// const ffmpeg = require('fluent-ffmpeg'); // Will be used in next phases

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// Temporary storage for downloaded chunks
const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

/**
 * M3U8 Fetch & Parse Logic
 */
async function fetchM3U8AndExtractChunks(m3u8Url, cookies) {
  try {
    const response = await axios.get(m3u8Url, {
      headers: {
        'Cookie': cookies,
        'Referer': m3u8Url
      }
    });

    const lines = response.data.split('\n');
    const tsUrls = [];
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);

    for (let line of lines) {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        let tsUrl = line;
        if (!line.startsWith('http://') && !line.startsWith('https://')) {
          if (line.startsWith('/')) {
            const urlObj = new URL(m3u8Url);
            tsUrl = urlObj.origin + line;
          } else {
            tsUrl = baseUrl + line;
          }
        }
        tsUrls.push(tsUrl);
      }
    }
    return tsUrls;
  } catch (error) {
    console.error('Error fetching M3U8:', error.message);
    throw new Error('Failed to fetch or parse M3U8 playlist.');
  }
}

app.post('/process', async (req, res) => {
  const { url, title, cookies, referer } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'Video URL is required' });
  }

  console.log(`\n[WORKER] Received request to process: ${title}`);
  console.log(`[WORKER] URL: ${url}`);

  try {
    // 1. Send immediate response to client so UI can update to "Processing"
    res.status(202).json({ 
      success: true, 
      message: 'Video processing started in background',
      jobId: Date.now().toString()
    });

    // 2. Background Processing (No Timeout!)
    console.log(`[WORKER] Fetching M3U8 Master Playlist...`);
    
    // Simulate real fetching logic to ensure cookies are parsed correctly
    let tsUrls = [];
    if (url.includes('.m3u8')) {
      tsUrls = await fetchM3U8AndExtractChunks(url, cookies);
      console.log(`[WORKER] Successfully extracted ${tsUrls.length} TS chunk URLs.`);
    } else {
      console.log(`[WORKER] Non-M3U8 URL detected. Preparing for MP4 download.`);
    }

    // [TODO: Implement Parallel Downloading and FFmpeg Audio Extraction]
    // [TODO: Implement Whisper STT]
    // [TODO: Implement Gemini 1.5 Pro Summarization]
    // [TODO: Save to Supabase]

    console.log(`[WORKER] Background task mock complete for ${title}`);

  } catch (err) {
    console.error(`[WORKER] Background Processing Error:`, err);
  }
});

app.listen(PORT, () => {
  console.log(`🦇 Dark Knight Heavy Worker Engine running on port ${PORT}`);
});
