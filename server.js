// @ts-nocheck
import 'dotenv/config';
import express from 'express';
import ytSearch from 'yt-search';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Pengambilan API Key secara aman dari environment variable
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

const apiClient = axios.create({ 
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  }
});

app.use(express.json());
app.use(express.static(publicDir));

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ROUTE 1: AI Agent (Groq)
app.post('/api/agent', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt tidak boleh kosong.' });

  try {
    let searchContext = "";
    try {
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(prompt)}`;
      const searchRes = await apiClient.get(searchUrl);
      const matches = [...searchRes.data.matchAll(/<a class="result__snippet"[^>]*>(.*?)<\/a>/g)];
      
      if (matches.length > 0) {
        searchContext = matches.slice(0, 3).map(m => m[1].replace(/<[^>]+>/g, '')).join("\n");
      }
    } catch (searchErr) {
      console.log("[Web Search Failure]: Melanjutkan tanpa data web.");
    }

    const groqResponse = await apiClient.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `Anda adalah AI Agent terintegrasi.
${searchContext ? `Data Terkini dari Web:\n${searchContext}\n` : ''}
Tugas Anda:
1. Jawab pertanyaan pengguna secara akurat dan ringkas (maksimal 2 kalimat).
2. Jika berkaitan dengan lagu/musik, sertakan kata kunci di akhir jawaban dengan format: [LAGU: Kata Kunci]`
          },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3
      },
      {
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    let aiReply = groqResponse.data.choices[0]?.message?.content || 'Permintaan berhasil diproses.';
    let songData = null;
    let searchQuery = prompt;
    const songMatch = aiReply.match(/\[LAGU:\s*(.*?)\]/i);

    if (songMatch && songMatch[1]) {
      searchQuery = songMatch[1].trim();
    }

    const searchResult = await ytSearch(searchQuery);
    if (searchResult && searchResult.videos && searchResult.videos.length > 0) {
      const topSong = searchResult.videos[0];
      songData = {
        title: topSong.title,
        url: topSong.url,
        thumbnail: topSong.thumbnail
      };
    }

    const cleanReply = aiReply.replace(/\[LAGU:.*?\]/gi, '').trim();

    res.json({
      model: 'Llama-3.3-70b (Web Search Integrated)',
      reply: cleanReply,
      song: songData
    });

  } catch (err) {
    console.error("[ERROR Agent]:", err.response?.data || err.message);
    res.status(500).json({ error: 'Gagal memproses permintaan AI Agent.' });
  }
});

// ROUTE 2: YouTube Search
app.get('/api/ytsearch', async (req, res) => {
  const query = req.query.query;
  if (!query) return res.status(400).json({ error: 'Kata kunci diperlukan' });
  try {
    const result = await ytSearch(query);
    const videos = (result && result.videos ? result.videos : []).slice(0, 8).map((item) => ({
      title: String(item.title || 'Tanpa Judul'),
      thumbnail: String(item.thumbnail || item.image || ''),
      author: String(item.author?.name || 'Unknown'),
      timestamp: String(item.timestamp || '-'),
      url: String(item.url || '')
    }));
    res.json(videos);
  } catch (err) {
    console.error("[ERROR YT Search]:", err.message);
    res.status(500).json({ error: 'Gagal mencari musik YouTube' });
  }
});

// ROUTE 3: TikTok Search & Downloader
app.get('/api/ttsearch', async (req, res) => {
  const query = req.query.query;
  if (!query) return res.status(400).json({ error: 'Kata kunci atau Link TikTok diperlukan.' });

  const isLink = /tiktok\.com/i.test(query);

  try {
    if (isLink) {
      const { stdout } = await execPromise(`yt-dlp -j --no-warnings "${query}"`);
      const info = JSON.parse(stdout);

      const item = {
        title: String(info.title || info.description || 'Video TikTok'),
        author: String(info.uploader || info.creator || 'Kreator TikTok'),
        cover: String(info.thumbnail || ''),
        play: String(info.webpage_url || query),
        music: `/api/stream?url=${encodeURIComponent(query)}`
      };

      return res.json({ data: [item] });

    } else {
      const searchResult = await ytSearch(`${query} tiktok`);
      const videos = (searchResult && searchResult.videos ? searchResult.videos : []).slice(0, 8).map((item) => ({
        title: String(item.title || 'TikTok Audio'),
        author: String(item.author?.name || 'Kreator TikTok'),
        cover: String(item.thumbnail || item.image || ''),
        play: String(item.url || ''),
        music: `/api/stream?url=${encodeURIComponent(item.url || '')}`
      }));

      if (videos.length > 0) {
        return res.json({ data: videos });
      } else {
        return res.status(404).json({ error: 'Hasil pencarian tidak ditemukan.' });
      }
    }
  } catch (err) {
    console.error("[ERROR Search Handler]:", err.message);
    res.status(500).json({ 
      error: 'Gagal memproses pencarian. Silakan pastikan koneksi server atau coba lagi.' 
    });
  }
});

// ROUTE 4: Audio Streaming
app.get('/api/stream', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL diperlukan');
  
  try {
    const { stdout } = await execPromise(`yt-dlp -g -f "ba[ext=m4a]/140/bestaudio[ext=m4a]/ba/b" "${url}"`);
    const audioUrl = stdout.trim().split('\n')[0];
    
    if (audioUrl) {
      res.redirect(audioUrl);
    } else {
      res.status(404).send('Audio tidak ditemukan');
    }
  } catch (err) {
    console.error("[ERROR Audio Stream]:", err.message);
    res.status(500).send('Gagal memuat streaming audio');
  }
});

// ROUTE 5: Audio Downloader
app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  const title = req.query.title || 'audio';
  if (!url) return res.status(400).send('URL diperlukan');
  
  try {
    const cleanTitle = title.replace(/[^a-zA-Z0-9\s-_]/g, '').trim().substring(0, 50) || 'audio';
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${cleanTitle} - Web Tools Hub.mp3"`);

    const ytdlp = spawn('yt-dlp', ['-f', 'ba/b', '-o', '-', url]);
    
    ytdlp.stdout.pipe(res);
    
    ytdlp.on('error', (err) => {
      console.error("[ERROR Download Stream]:", err);
      if (!res.headersSent) res.status(500).send('Gagal memproses unduhan');
    });
  } catch (err) {
    console.error("[ERROR Download]:", err.message);
    if (!res.headersSent) res.status(500).send('Gagal memproses unduhan');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server aktif di port ${PORT}`);
});
