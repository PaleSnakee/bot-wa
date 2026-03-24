const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const qrcode = require("qrcode-terminal");
const crypto = require("crypto");
const https = require("https");
const ffmpegPath = require("ffmpeg-static");
const axios = require("axios");
const cheerio = require("cheerio");
const yts = require("yt-search");
const { Sticker } = require("wa-sticker-formatter");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const settings = require("./setting");

const PREFIX = settings.prefix || ".";
const OWNER_NAME = settings.ownerName || "Owner";
const OWNER_NUMBER = String(settings.ownerNumber || "").trim();
const BOT_NAME = settings.botName || "Bot WA";
const BOT_NUMBER = String(settings.botNumber || OWNER_NUMBER).trim();
const DB_PATH = path.join(__dirname, "database.json");
const FAMILY100_PATH = path.join(__dirname, "json", "family100.json");
const MENU_BANNER_PATH = settings.menuImage
  ? path.resolve(__dirname, settings.menuImage)
  : path.join(__dirname, "assets", "img", "banner.jpg");
const PAIRING_NUMBER = normalizeNumber(
  process.env.PAIRING_NUMBER || process.env.WA_PHONE_NUMBER || BOT_NUMBER,
);
const SHOW_PAIRING_NOTIFICATION =
  process.env.SHOW_PAIRING_NOTIFICATION !== "false";
const PAIRING_INTERVAL_MS = Number(process.env.PAIRING_INTERVAL_MS) || 180000;
const PAIRING_CODE_TIMEOUT_MS =
  Number(process.env.PAIRING_CODE_TIMEOUT_MS) || 25000;
const STATUS_BROADCAST_ID = "status@broadcast";
const GROUP_LINK_REGEX = /chat\.whatsapp\.com\/(?:invite\/)?([0-9A-Za-z]{20,24})/i;
const TIKTOK_URL_REGEX =
  /(https:\/\/(?:vt|vm)\.tiktok\.com\/[^\s]+|https:\/\/www\.tiktok\.com\/@[\w.-]+\/video\/\d+)/i;
const AUTH_SESSION_PATH = path.join(__dirname, ".wwebjs_auth", "session");
const TEMP_MEDIA_DIR = path.join(__dirname, ".tmp_media");
const FAMILY100_WIN_SCORE = 4999;
const FAMILY100_NEAR_THRESHOLD = 0.72;
const FAMILY100_MATCH_THRESHOLD = 0.9;
const FAMILY100_TIME_LIMIT = 120000;
const MAX_AUDIO_DOWNLOAD_BYTES =
  Number(process.env.MAX_AUDIO_DOWNLOAD_BYTES) || 25 * 1024 * 1024;
const MAX_VIDEO_DOWNLOAD_BYTES =
  Number(process.env.MAX_VIDEO_DOWNLOAD_BYTES) || 50 * 1024 * 1024;
const SaveNow = {
  _api: "https://p.savenow.to",
  _key: "dfcb6d76f2f6a9894gjkege8a4ab232222",
  _agent: new https.Agent({ rejectUnauthorized: false }),
  poll: async (url, limit = 40) => {
    for (let i = 0; i < limit; i += 1) {
      try {
        const { data } = await axios.get(url, {
          httpsAgent: SaveNow._agent,
        });
        if (data.success === 1 && data.download_url) {
          return data;
        }
        if (data.success === -1) {
          break;
        }
      } catch (error) {
        // ignore polling errors and continue retrying
      }
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    return null;
  },
};
const CHROME_CANDIDATE_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
let isPublicMode = true;
let pairingCodeReceived = false;
let pairingTimeout = null;
let blockedStatusMessageCount = 0;
let blockedStatusLogTimer = null;
const startupTime = Date.now();
const family100Games = new Map();
const jadibotClients = new Map();

function normalizeNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function loadDatabase() {
  const defaultData = {
    owners: [normalizeNumber(OWNER_NUMBER)],
    premiums: [],
    groups: {},
    users: {},
  };

  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }

  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      owners: Array.isArray(parsed.owners)
        ? parsed.owners.map(normalizeNumber).filter(Boolean)
        : defaultData.owners,
      premiums: Array.isArray(parsed.premiums)
        ? parsed.premiums.map(normalizeNumber).filter(Boolean)
        : [],
      groups:
        parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups)
          ? parsed.groups
          : {},
      users:
        parsed.users && typeof parsed.users === "object" && !Array.isArray(parsed.users)
          ? parsed.users
          : {},
    };
  } catch (error) {
    console.error("Gagal membaca database.json, memakai data default.", error);
    return defaultData;
  }
}

let database = loadDatabase();

function saveDatabase() {
  fs.writeFileSync(DB_PATH, JSON.stringify(database, null, 2));
}

function ensureTempMediaDir() {
  if (!fs.existsSync(TEMP_MEDIA_DIR)) {
    fs.mkdirSync(TEMP_MEDIA_DIR, { recursive: true });
  }
}

function ensureFamily100Dir() {
  const directoryPath = path.dirname(FAMILY100_PATH);
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
}

function ensureUserProfile(userId) {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    return null;
  }

  if (!database.users || typeof database.users !== "object") {
    database.users = {};
  }

  if (!database.users[normalizedUserId]) {
    database.users[normalizedUserId] = {
      exp: 0,
    };
  }

  if (typeof database.users[normalizedUserId].exp !== "number") {
    database.users[normalizedUserId].exp = Number(database.users[normalizedUserId].exp) || 0;
  }

  return database.users[normalizedUserId];
}

function normalizeGameText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");

  if (!left.length) {
    return right.length;
  }

  if (!right.length) {
    return left.length;
  }

  const matrix = Array.from({ length: left.length + 1 }, () =>
    Array(right.length + 1).fill(0),
  );

  for (let i = 0; i <= left.length; i += 1) {
    matrix[i][0] = i;
  }

  for (let j = 0; j <= right.length; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  return matrix[left.length][right.length];
}

function similarityScore(a, b) {
  const left = normalizeGameText(a);
  const right = normalizeGameText(b);

  if (!left || !right) {
    return 0;
  }

  if (left === right) {
    return 1;
  }

  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) {
    return 1;
  }

  const distance = levenshteinDistance(left, right);
  return 1 - distance / maxLength;
}

function loadFamily100Questions() {
  if (!fs.existsSync(FAMILY100_PATH)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(FAMILY100_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    logStage("WARN", `Gagal membaca soal family100: ${error.message}`);
    return [];
  }
}

function formatFamily100Answers(answers, answeredBy = []) {
  return answers
    .map((answer, index) => {
      const winnerId = answeredBy[index];
      return winnerId
        ? `(${index + 1}) ${answer} @${winnerId.split("@")[0]}`
        : `(${index + 1}) ${answer}`;
    })
    .join("\n");
}

function getFamily100SessionId(activeClient, chatId) {
  const botId = activeClient?.info?.wid?._serialized || "main";
  return `${botId}:${chatId}`;
}

function getGroupSettings(chatId) {
  if (!database.groups || typeof database.groups !== "object") {
    database.groups = {};
  }

  if (!database.groups[chatId]) {
    database.groups[chatId] = {
      antiLink: false,
    };
  }

  return database.groups[chatId];
}

function cleanupStaleSessionLocks() {
  const lockFiles = [
    "lockfile",
    "SingletonLock",
    "SingletonCookie",
    "SingletonSocket",
    "DevToolsActivePort",
  ];

  for (const lockFile of lockFiles) {
    const filePath = path.join(AUTH_SESSION_PATH, lockFile);

    if (!fs.existsSync(filePath)) {
      continue;
    }

    try {
      fs.rmSync(filePath, { force: true });
      logStage("CLEANUP", `File session lama dibersihkan: ${lockFile}`);
    } catch (error) {
      logStage("CLEANUP", `Gagal membersihkan ${lockFile}: ${error.message}`);
    }
  }
}

function resolveBrowserExecutablePath() {
  return CHROME_CANDIDATE_PATHS.find((candidatePath) =>
    fs.existsSync(candidatePath),
  );
}

const browserExecutablePath = resolveBrowserExecutablePath();
const originalInject = Client.prototype.inject;

Client.prototype.inject = async function injectWithRetry(...args) {
  const maxAttempts = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await originalInject.apply(this, args);
    } catch (error) {
      const errorMessage = String(error?.message || error || "");
      const isRecoverable =
        errorMessage.includes("Execution context was destroyed") ||
        errorMessage.includes("Cannot find context with specified id");

      if (!isRecoverable || attempt === maxAttempts) {
        throw error;
      }

      logStage(
        "RETRY",
        `Inject WhatsApp diulang (${attempt}/${maxAttempts}) karena halaman masih reload.`,
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
};

const client = new Client({
  authStrategy: new LocalAuth(),
  webVersionCache: {
    type: "none",
  },
  ...(PAIRING_NUMBER
    ? {
        pairWithPhoneNumber: {
          phoneNumber: PAIRING_NUMBER,
          showNotification: SHOW_PAIRING_NOTIFICATION,
          intervalMs: PAIRING_INTERVAL_MS,
        },
      }
    : {}),
  puppeteer: {
    headless: true,
    ...(browserExecutablePath
      ? {
          executablePath: browserExecutablePath,
        }
      : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

function clearPairingTimeout() {
  if (pairingTimeout) {
    clearTimeout(pairingTimeout);
    pairingTimeout = null;
  }
}

function logStage(stage, detail) {
  const elapsedSeconds = ((Date.now() - startupTime) / 1000).toFixed(1);
  const timestamp = new Date().toLocaleTimeString("id-ID", {
    hour12: false,
  });
  console.log(
    `[${timestamp} +${elapsedSeconds}s] ${stage}${detail ? ` - ${detail}` : ""}`,
  );
}

function logBlockedStatusMessage() {
  blockedStatusMessageCount += 1;

  if (blockedStatusLogTimer) {
    return;
  }

  blockedStatusLogTimer = setTimeout(() => {
    logStage(
      "BLOCKED",
      `${blockedStatusMessageCount} pesan dari status@broadcast diabaikan.`,
    );
    blockedStatusMessageCount = 0;
    blockedStatusLogTimer = null;
  }, 2000);
}

async function safeSendMessage(chatId, content, options, activeClient = client) {
  if (chatId === STATUS_BROADCAST_ID) {
    logStage("BLOCKED", "Percobaan kirim ke status@broadcast dibatalkan.");
    return null;
  }

  return activeClient.sendMessage(chatId, content, options);
}

function startPairingTimeout() {
  if (!PAIRING_NUMBER) {
    return;
  }

  clearPairingTimeout();
  pairingTimeout = setTimeout(() => {
    if (pairingCodeReceived) {
      return;
    }

    console.warn(
      `Pairing code belum muncul setelah ${Math.floor(
        PAIRING_CODE_TIMEOUT_MS / 1000,
      )} detik. Ini masih bisa normal kalau WhatsApp Web sedang loading atau session lama sedang dicek.`,
    );
    console.warn(
      "Kalau terlalu lama, tutup bot lalu coba hapus session di .wwebjs_auth agar pairing dimulai dari awal.",
    );
  }, PAIRING_CODE_TIMEOUT_MS);
}

client.on("qr", (qr) => {
  logStage("QR", "Scan QR berikut untuk login ke WhatsApp.");
  qrcode.generate(qr, { small: true });
});

client.on("code", (code) => {
  pairingCodeReceived = true;
  clearPairingTimeout();
  const formattedCode = code.match(/.{1,4}/g)?.join("-") || code;
  logStage("PAIRING", `Code diterima: ${formattedCode}`);
  logStage(
    "PAIRING",
    "Masukkan kode di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.",
  );
});

client.on("loading_screen", (percent, message) => {
  logStage("LOADING", `${percent}% - ${message}`);
});

client.on("change_state", (state) => {
  logStage("STATE", state);
});

client.on("authenticated", () => {
  clearPairingTimeout();
  logStage("AUTH", "Autentikasi berhasil.");
});

client.on("auth_failure", (message) => {
  clearPairingTimeout();
  logStage("AUTH", `Autentikasi gagal: ${message}`);
});

client.on("ready", () => {
  logStage("READY", "Bot WhatsApp siap digunakan.");
});

client.on("disconnected", (reason) => {
  clearPairingTimeout();
  logStage("DISCONNECTED", reason);
});

if (PAIRING_NUMBER) {
  logStage("BOOT", `Mode pairing code aktif untuk nomor ${PAIRING_NUMBER}.`);
  logStage(
    "BOOT",
    "Menyiapkan WhatsApp Web dan menunggu pairing code muncul...",
  );
  startPairingTimeout();
} else {
  logStage(
    "BOOT",
    "Mode QR aktif. Set PAIRING_NUMBER untuk login dengan pairing code.",
  );
}

if (browserExecutablePath) {
  logStage("BOOT", `Browser terdeteksi: ${browserExecutablePath}`);
} else {
  logStage(
    "BOOT",
    "Browser lokal tidak terdeteksi. Set PUPPETEER_EXECUTABLE_PATH atau CHROME_PATH jika bot gagal start.",
  );
}

logStage(
  "BOOT",
  "Web cache WhatsApp dimatikan agar selalu pakai halaman live terbaru.",
);
cleanupStaleSessionLocks();
ensureFamily100Dir();

async function isOwner(message) {
  const candidates = [
    message.author,
    message.from,
    message.id?.participant,
    message._data?.author,
    message._data?.from,
    message._data?.participant,
  ]
    .map(normalizeNumber)
    .filter(Boolean);

  try {
    const contact = await message.getContact();
    candidates.push(normalizeNumber(contact.number));
    candidates.push(normalizeNumber(contact.id?.user));
    candidates.push(normalizeNumber(contact.id?._serialized));
  } catch (error) {
    console.warn("Gagal mengambil contact pengirim untuk validasi owner.");
  }

  return candidates.some((candidate) => database.owners.includes(candidate));
}

function getParticipantSerializedId(participant) {
  return (
    participant?.id?._serialized ||
    participant?.id?.user ||
    participant?._serialized ||
    ""
  );
}

function isParticipantAdmin(participant) {
  return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
}

async function getGroupAdminState(activeClient, message) {
  const chat = await message.getChat();
  if (!chat?.isGroup) {
    return {
      chat,
      isSenderAdmin: false,
      isBotAdmin: false,
    };
  }

  const senderCandidates = [
    message.author,
    message.id?.participant,
    message._data?.author,
    message._data?.participant,
  ].filter(Boolean);
  const senderCandidateSet = new Set(
    senderCandidates.map((candidate) => String(candidate).trim()).filter(Boolean),
  );
  const botId = activeClient.info?.wid?._serialized;

  let isSenderAdmin = false;
  let isBotAdmin = false;

  for (const participant of chat.participants || []) {
    const participantId = getParticipantSerializedId(participant);

    if (!isSenderAdmin && senderCandidateSet.has(participantId)) {
      isSenderAdmin = isParticipantAdmin(participant);
    }

    if (!isBotAdmin && botId && participantId === botId) {
      isBotAdmin = isParticipantAdmin(participant);
    }

    if (isSenderAdmin && isBotAdmin) {
      break;
    }
  }

  return {
    chat,
    isSenderAdmin,
    isBotAdmin,
  };
}

async function shouldBlockGroupLink(activeClient, message) {
  if (!message.from || !String(message.from).endsWith("@g.us")) {
    return { shouldBlock: false };
  }

  const text = String(message.body || "").trim();
  const match = GROUP_LINK_REGEX.exec(text);
  if (!match) {
    return { shouldBlock: false };
  }

  const groupSettings = getGroupSettings(message.from);
  if (!groupSettings.antiLink) {
    return { shouldBlock: false };
  }

  const { chat, isSenderAdmin, isBotAdmin } = await getGroupAdminState(activeClient, message);
  if (isSenderAdmin || (await isOwner(message))) {
    return { shouldBlock: false };
  }

  if (isBotAdmin && typeof chat?.getInviteCode === "function") {
    try {
      const currentInviteCode = await chat.getInviteCode();
      if (currentInviteCode && match[1] === currentInviteCode) {
        return { shouldBlock: false };
      }
    } catch (error) {
      logStage(
        "WARN",
        `Gagal mengambil invite code grup ${message.from}: ${error.message}`,
      );
    }
  }

  return {
    shouldBlock: true,
    isBotAdmin,
  };
}

async function downloadSocialMedia(platform, inputUrl) {
  if (platform === "tiktok") {
    const result = await getTikTokDownloadResult(inputUrl);

    if (Array.isArray(result.images) && result.images.length > 0) {
      return result.images;
    }

    if (result.videoUrl) {
      return [result.videoUrl];
    }

    throw new Error("Link download TikTok tidak ditemukan");
  }

  const siteUrl = "https://instatiktok.com/";
  const form = new URLSearchParams();
  form.append("url", inputUrl);
  form.append("platform", platform);
  form.append("siteurl", siteUrl);

  const response = await axios.post(`${siteUrl}api`, form.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Origin: siteUrl,
      Referer: siteUrl,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  const html = response?.data?.html;
  if (!html || response?.data?.status !== "success") {
    throw new Error("Gagal ambil data");
  }

  const $ = cheerio.load(html);
  const links = [];

  $("a.btn[href^='http']").each((_, el) => {
    const link = $(el).attr("href");
    if (link && !links.includes(link)) {
      links.push(link);
    }
  });

  if (links.length === 0) {
    throw new Error("Link download tidak ditemukan");
  }

  if (platform === "instagram") {
    return links;
  }

  if (platform === "facebook") {
    return [links.at(-1)];
  }

  throw new Error("Platform tidak valid");
}

async function getSimiReply(text) {
  const response = await fetch(
    `https://api.nexray.web.id/ai/simisimi?text=${encodeURIComponent(text)}`,
  );

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const result = await response.json();
  if (!result?.status || !result.result) {
    throw new Error("Teu meunang jawaban ti Simi.");
  }

  return result.result;
}

function sanitizeFileName(value) {
  return (
    String(value || "audio")
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
      .trim()
      .slice(0, 80) || "audio"
  );
}

async function streamToBuffer(readable, maxBytes = MAX_AUDIO_DOWNLOAD_BYTES) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of readable) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufferChunk.length;

    if (totalBytes > maxBytes) {
      throw new Error(
        "Ukuran audio terlalu besar untuk dikirim. Coba pilih lagu yang lebih pendek.",
      );
    }

    chunks.push(bufferChunk);
  }

  return Buffer.concat(chunks);
}

function formatNumber(num) {
  if (num >= 1000000000) {
    return `${(num / 1000000000).toFixed(1).replace(/\.0$/, "")}B`;
  }
  if (num >= 1000000) {
    return `${(num / 1000000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (num >= 1000) {
    return `${(num / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(num || 0);
}

function formatFullNumber(num) {
  return Number(num || 0).toLocaleString("id-ID");
}

function formatDurationClock(sec = 0) {
  const totalSeconds = Math.max(0, Number(sec) || 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${minutes}:${seconds}`;
  }

  return `${minutes}:${seconds}`;
}

async function getTikTokDownloadResult(input) {
  const normalizedInput = String(input || "").trim();
  if (!normalizedInput) {
    throw new Error("Input TikTok kosong.");
  }

  const url = normalizedInput.match(TIKTOK_URL_REGEX)?.[0];
  let data;

  if (url) {
    const response = await fetch(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`,
    );
    const result = await response.json();
    if (!result?.data) {
      throw new Error("Gagal mengambil data TikTok.");
    }
    data = result.data;
  } else {
    const searchResponse = await fetch(
      `https://www.tikwm.com/api/feed/search?keywords=${encodeURIComponent(normalizedInput)}&count=1&cursor=0&web=1&hd=1`,
    );
    const searchResult = await searchResponse.json();
    const video = searchResult?.data?.videos?.[0];

    if (!video) {
      throw new Error(`Hasil tidak ditemukan untuk "${normalizedInput}"`);
    }

    const detailResponse = await fetch(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(`https://www.tiktok.com/@${video.author.unique_id}/video/${video.video_id}`)}&hd=1`,
    );
    const detailResult = await detailResponse.json();

    if (!detailResult?.data) {
      throw new Error("Gagal mengambil data hasil search.");
    }

    data = detailResult.data;
  }

  return {
    title: data.title || "-",
    authorName: data.author?.nickname || data.author?.unique_id || "-",
    authorUsername: data.author?.unique_id || "-",
    duration: formatDurationClock(data.duration),
    views: formatFullNumber(data.play_count),
    images: Array.isArray(data.images) ? data.images.filter(Boolean) : [],
    videoUrl: data.play || data.hdplay || "",
    audioUrl: data.music_info?.play || "",
  };
}

async function searchYouTubeVideo(query) {
  const search = await yts(query);
  const videos = Array.isArray(search?.videos) ? search.videos : [];
  const video = videos.find((item) => item?.url);

  if (!video) {
    throw new Error(`Maaf, tidak dapat menemukan lagu dengan kata "${query}"`);
  }

  return video;
}

async function getSpotifyPlayResult(query) {
  const apiUrl = `https://api.nexray.web.id/downloader/spotifyplay?q=${encodeURIComponent(query)}`;
  const { data } = await axios.get(apiUrl);

  if (!data?.status || !data?.result) {
    throw new Error("Lagu tidak ditemukan");
  }

  return data.result;
}

async function createMediaFromRemoteUrl(url, maxBytes, defaultMimeType, filename) {
  const response = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Gagal mengunduh media YouTube. HTTP ${response.status}`);
  }

  const buffer = await streamToBuffer(response.body, maxBytes);
  const mimeType = response.headers.get("content-type")?.split(";")[0] || defaultMimeType;

  return new MessageMedia(
    mimeType,
    buffer.toString("base64"),
    filename,
    buffer.length,
  );
}

function runYtDlp(args, maxBytes) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-m", "yt_dlp", ...args], {
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let totalBytes = 0;

    child.stdout.on("data", (chunk) => {
      const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += bufferChunk.length;

      if (typeof maxBytes === "number" && totalBytes > maxBytes) {
        child.kill("SIGTERM");
        reject(
          new Error(
            "Ukuran media YouTube terlalu besar untuk dikirim. Coba video yang lebih pendek.",
          ),
        );
        return;
      }

      stdoutChunks.push(bufferChunk);
    });

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      reject(
        new Error(`Gagal menjalankan yt-dlp lokal: ${error.message}`),
      );
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(
            stderr || `yt-dlp keluar dengan kode ${code}.`,
          ),
        );
        return;
      }

      resolve(Buffer.concat(stdoutChunks));
    });
  });
}

function runYtDlpToFile(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", ["-m", "yt_dlp", ...args], {
      windowsHide: true,
    });
    const stderrChunks = [];

    child.stderr.on("data", (chunk) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on("error", (error) => {
      reject(new Error(`Gagal menjalankan yt-dlp lokal: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(new Error(stderr || `yt-dlp keluar dengan kode ${code}.`));
        return;
      }

      resolve();
    });
  });
}

async function getYouTubeMetadata(url) {
  const output = await runYtDlp(
    ["--dump-single-json", "--no-playlist", "--no-warnings", url],
    5 * 1024 * 1024,
  );
  return JSON.parse(output.toString("utf8"));
}

async function createYouTubeMediaViaYtDlp(url, mode, title) {
  const isAudio = mode === "audio";
  const metadata = await getYouTubeMetadata(url);
  const filenameBase = sanitizeFileName(metadata?.title || title);
  if (isAudio) {
    ensureTempMediaDir();
    const tempBase = path.join(
      TEMP_MEDIA_DIR,
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
    );
    const outputTemplate = `${tempBase}.%(ext)s`;

    await runYtDlpToFile([
      "--no-playlist",
      "--no-warnings",
      "-f",
      "ba/b",
      "-x",
      "--audio-format",
      "mp3",
      "--ffmpeg-location",
      ffmpegPath,
      "-o",
      outputTemplate,
      url,
    ]);

    const outputPath = `${tempBase}.mp3`;
    const buffer = fs.readFileSync(outputPath);
    fs.rmSync(outputPath, { force: true });

    if (buffer.length > MAX_AUDIO_DOWNLOAD_BYTES) {
      throw new Error(
        "Ukuran audio terlalu besar untuk dikirim. Coba pilih lagu yang lebih pendek.",
      );
    }

    return new MessageMedia(
      "audio/mpeg",
      buffer.toString("base64"),
      `${filenameBase}.mp3`,
      buffer.length,
    );
  }

  const buffer = await runYtDlp(
    [
      "--no-playlist",
      "--no-warnings",
      "-f",
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
      "-o",
      "-",
      url,
    ],
    MAX_VIDEO_DOWNLOAD_BYTES,
  );

  return new MessageMedia(
    "video/mp4",
    buffer.toString("base64"),
    `${filenameBase}.mp4`,
    buffer.length,
  );
}

async function ytdlv1(url, type) {
  try {
    const endpoint =
      type === "audio"
        ? `https://ytdlpyton.nvlgroup.my.id/download/audio?url=${encodeURIComponent(url)}&mode=url`
        : `https://ytdlpyton.nvlgroup.my.id/download/?url=${encodeURIComponent(url)}&resolution=${type}&mode=url`;
    const { data } = await axios.get(endpoint);
    return {
      title: data.title || "YouTube Media",
      download_url: data.download_url,
      status: Boolean(data.download_url),
      reason: data.download_url ? "" : "respons kosong dari ytdlv1",
    };
  } catch (error) {
    return {
      status: false,
      reason: error?.response?.status
        ? `HTTP ${error.response.status}`
        : error.message,
    };
  }
}

async function ytdlv2(url, type) {
  try {
    const format = type === "audio" ? "mp3" : "mp4";
    const { data } = await axios.get(
      `https://api.nekolabs.my.id/downloader/youtube/v1?url=${encodeURIComponent(url)}&format=${format}`,
    );
    if (data.success && data.result) {
      return {
        title: data.result.title || "YouTube Media",
        download_url: data.result.downloadUrl,
        status: true,
      };
    }
    return {
      status: false,
      reason: "respons kosong dari ytdlv2",
    };
  } catch (error) {
    return {
      status: false,
      reason: error?.response?.status
        ? `HTTP ${error.response.status}`
        : error.message,
    };
  }
}

async function ytdlv3(url, resolution) {
  try {
    const { data } = await axios.get(
      `https://anabot.my.id/api/download/ytmp4?url=${encodeURIComponent(url)}&quality=${resolution}&apikey=freeApikey`,
    );
    if (data.success && data.data?.result) {
      return {
        title: data.data.result.metadata?.title || "YouTube Video",
        download_url: data.data.result.urls,
        status: true,
      };
    }
    return {
      status: false,
      reason: "respons kosong dari ytdlv3",
    };
  } catch (error) {
    return {
      status: false,
      reason: error?.response?.status
        ? `HTTP ${error.response.status}`
        : error.message,
    };
  }
}

async function ytdlv4(url, res) {
  try {
    const format = res === "audio" ? "mp3" : res;
    const { data: init } = await axios.get(`${SaveNow._api}/ajax/download.php`, {
      params: {
        copyright: 0,
        format,
        url,
        api: SaveNow._key,
      },
      httpsAgent: SaveNow._agent,
    });

    if (!init.success) {
      return {
        status: false,
        reason: "respons awal SaveNow tidak sukses",
      };
    }

    const result = await SaveNow.poll(init.progress_url);
    if (result?.download_url) {
      return {
        status: true,
        title: init.info?.title || "YouTube Media",
        download_url: result.download_url,
      };
    }

    return {
      status: false,
      reason: "SaveNow tidak memberi link download",
    };
  } catch (error) {
    return {
      status: false,
      reason: error?.response?.status
        ? `HTTP ${error.response.status}`
        : error.message,
    };
  }
}

async function ytdlv5(url, type) {
  try {
    const format = type === "audio" ? "mp3" : "videos";
    const { data } = await axios.get(
      "https://www.yt2mp3converter.net/apis/fetch.php",
      {
        params: {
          url,
          format,
        },
        headers: {
          Referer: "https://www.yt2mp3.cloud/",
          Origin: "https://www.yt2mp3.cloud",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
        timeout: 20000,
      },
    );

    const downloadUrl =
      data?.download ||
      data?.download_url ||
      data?.url ||
      data?.result?.download ||
      data?.result?.download_url;

    if (!downloadUrl) {
      return {
        status: false,
        reason: "yt2mp3converter tidak memberi link download",
      };
    }

    return {
      status: true,
      title: data?.title || data?.result?.title || "YouTube Media",
      download_url: downloadUrl,
    };
  } catch (error) {
    return {
      status: false,
      reason: error?.response?.status
        ? `yt2mp3converter HTTP ${error.response.status}`
        : error.message,
    };
  }
}

async function getYouTubeFallbackDownload(url, type) {
  const fallbacks =
    type === "audio"
      ? [
          ["ytdlv1", () => ytdlv1(url, "audio")],
          ["ytdlv2", () => ytdlv2(url, "audio")],
          ["ytdlv4", () => ytdlv4(url, "audio")],
          ["ytdlv5", () => ytdlv5(url, "audio")],
        ]
      : [
          ["ytdlv1", () => ytdlv1(url, "720")],
          ["ytdlv2", () => ytdlv2(url, "mp4")],
          ["ytdlv3", () => ytdlv3(url, "720")],
          ["ytdlv4", () => ytdlv4(url, "720")],
          ["ytdlv5", () => ytdlv5(url, "video")],
        ];
  const errors = [];

  for (const [name, fallback] of fallbacks) {
    const result = await fallback();
    if (result?.status && result.download_url) {
      return result;
    }

    errors.push(`${name}: ${result?.reason || "gagal"}`);
  }

  throw new Error(
    `Semua fallback downloader YouTube untuk ${type} gagal dipakai. Detail: ${errors.join(" | ")}`,
  );
}

async function createYouTubeAudioMediaFromUrl(url, title) {
  try {
    return await createYouTubeMediaViaYtDlp(url, "audio", title);
  } catch (ytDlpError) {
    logStage("WARN", `yt-dlp audio gagal, pindah ke fallback API: ${ytDlpError.message}`);
    const fallback = await getYouTubeFallbackDownload(url, "audio");
    return createMediaFromRemoteUrl(
      fallback.download_url,
      MAX_AUDIO_DOWNLOAD_BYTES,
      "audio/mpeg",
      `${sanitizeFileName(fallback.title || title)}.mp3`,
    );
  }
}

async function createYouTubeVideoMediaFromUrl(url, title) {
  try {
    return await createYouTubeMediaViaYtDlp(url, "video", title);
  } catch (ytDlpError) {
    logStage("WARN", `yt-dlp video gagal, pindah ke fallback API: ${ytDlpError.message}`);
    const fallback = await getYouTubeFallbackDownload(url, "video");
    return createMediaFromRemoteUrl(
      fallback.download_url,
      MAX_VIDEO_DOWNLOAD_BYTES,
      "video/mp4",
      `${sanitizeFileName(fallback.title || title)}.mp4`,
    );
  }
}

async function getImageMediaFromMessage(message) {
  if (message.hasMedia) {
    const media = await message.downloadMedia();
    if (media && media.mimetype && media.mimetype.startsWith("image/")) {
      return media;
    }
  }

  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    if (quoted.hasMedia) {
      const media = await quoted.downloadMedia();
      if (media && media.mimetype && media.mimetype.startsWith("image/")) {
        return media;
      }
    }
  }

  return null;
}

async function getMediaFromMessage(message) {
  if (message.hasMedia) {
    const media = await message.downloadMedia();
    if (media) {
      return media;
    }
  }

  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    if (quoted.hasMedia) {
      const media = await quoted.downloadMedia();
      if (media) {
        return media;
      }
    }
  }

  return null;
}

function getExtensionFromMimeType(mimetype) {
  const rawExtension = String(mimetype || "").split("/")[1] || "bin";
  return rawExtension.split(";")[0].trim() || "bin";
}

async function uploadMediaToCdn(media) {
  const extension = getExtensionFromMimeType(media.mimetype);
  const filename = `upload_${Date.now()}.${extension}`;
  const buffer = Buffer.from(media.data, "base64");
  const form = new FormData();
  const blob = new Blob([buffer], {
    type: media.mimetype || "application/octet-stream",
  });

  form.append("file", blob, filename);

  const response = await fetch("https://cdn.nekohime.site/upload", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const result = await response.json();
  const url = result?.files?.[0]?.url || result?.files?.[0];
  if (!url) {
    throw new Error("Upload gagal");
  }

  return url;
}

async function createAnimeBratMedia(text) {
  const apiUrl = `https://api.nexray.web.id/maker/bratanime?text=${encodeURIComponent(
    text,
  )}`;
  const response = await fetch(apiUrl);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  let imageBuffer;
  let imageMimeType = contentType || "image/png";

  if (contentType.includes("application/json")) {
    const result = await response.json();
    const imageUrl =
      result?.result?.url ||
      result?.result?.image ||
      result?.result ||
      result?.url;

    if (!imageUrl || typeof imageUrl !== "string") {
      throw new Error("API animebrat tidak mengembalikan gambar yang valid.");
    }

    if (/^https?:\/\//i.test(imageUrl)) {
      return MessageMedia.fromUrl(imageUrl, {
        unsafeMime: true,
        filename: "animebrat.png",
      });
    }

    if (typeof result?.result === "string") {
      imageBuffer = Buffer.from(result.result, "base64");
      imageMimeType = "image/png";
    } else {
      throw new Error("API animebrat tidak mengembalikan URL gambar yang valid.");
    }
  } else {
    imageBuffer = Buffer.from(await response.arrayBuffer());
  }

  if (!imageBuffer || imageBuffer.length === 0) {
    throw new Error("API animebrat mengembalikan buffer kosong.");
  }

  return new MessageMedia(
    imageMimeType.split(";")[0] || "image/png",
    imageBuffer.toString("base64"),
    "animebrat.png",
    imageBuffer.length,
  );
}

async function resolveBratText(message, args) {
  if (args.length > 0) {
    return args.join(" ").trim();
  }

  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    const quotedText = String(quoted.body || quoted.caption || "").trim();
    if (quotedText) {
      return quotedText;
    }
  }

  return "";
}

async function createBratSticker(text) {
  const responseUrl = `https://aqul-brat.hf.space?text=${encodeURIComponent(text)}`;
  const sticker = new Sticker(responseUrl, {
    type: "crop",
    pack: "Sticker Pack",
    author: "Bot",
    quality: 10,
  });
  const stickerBuffer = await sticker.toBuffer();

  return new MessageMedia(
    "image/webp",
    stickerBuffer.toString("base64"),
    "brat.webp",
    stickerBuffer.length,
  );
}

async function getQuotedOrOwnMedia(message) {
  if (message.hasQuotedMsg) {
    const quoted = await message.getQuotedMessage();
    if (quoted.hasMedia) {
      const media = await quoted.downloadMedia();
      if (media) {
        return media;
      }
    }
  }

  if (message.hasMedia) {
    const media = await message.downloadMedia();
    if (media) {
      return media;
    }
  }

  return null;
}

async function enhanceVideoToHd(media) {
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
  const serial = crypto
    .createHash("md5")
    .update(userAgent + Date.now())
    .digest("hex");
  const videoBuffer = Buffer.from(media.data, "base64");
  const makeHeaders = (extra = {}) => ({
    accept: "*/*",
    "product-serial": serial,
    "user-agent": userAgent,
    Referer: "https://unblurimage.ai/",
    ...extra,
  });

  const fileName = `${crypto.randomBytes(3).toString("hex")}_video.mp4`;
  const registerForm = new FormData();
  registerForm.append("video_file_name", fileName);

  const registerResponse = await fetch(
    "https://api.unblurimage.ai/api/upscaler/v1/ai-video-enhancer/upload-video",
    {
      method: "POST",
      headers: makeHeaders(),
      body: registerForm,
    },
  );

  if (!registerResponse.ok) {
    throw new Error(`Gagal register video. HTTP ${registerResponse.status}`);
  }

  const registerResult = await registerResponse.json();
  const ossUrl = registerResult?.result?.url;
  const objectName = registerResult?.result?.object_name;
  if (!ossUrl || !objectName) {
    throw new Error("Gagal mendapatkan URL upload video.");
  }

  const uploadResponse = await fetch(ossUrl, {
    method: "PUT",
    headers: {
      "Content-Type": media.mimetype || "video/mp4",
      "User-Agent": userAgent,
    },
    body: videoBuffer,
  });

  if (!uploadResponse.ok) {
    throw new Error(`Gagal upload video. HTTP ${uploadResponse.status}`);
  }

  const createJobForm = new FormData();
  createJobForm.append(
    "original_video_file",
    `https://cdn.unblurimage.ai/${objectName}`,
  );
  createJobForm.append("resolution", "2k");
  createJobForm.append("is_preview", "false");

  const createJobResponse = await fetch(
    "https://api.unblurimage.ai/api/upscaler/v2/ai-video-enhancer/create-job",
    {
      method: "POST",
      headers: makeHeaders(),
      body: createJobForm,
    },
  );

  if (!createJobResponse.ok) {
    throw new Error(`Gagal membuat job. HTTP ${createJobResponse.status}`);
  }

  const createJobResult = await createJobResponse.json();
  const jobId = createJobResult?.result?.job_id;
  if (!jobId) {
    throw new Error("Gagal membuat tugas pemrosesan.");
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const checkResponse = await fetch(
      `https://api.unblurimage.ai/api/upscaler/v2/ai-video-enhancer/get-job/${jobId}`,
      {
        headers: makeHeaders(),
      },
    );

    if (!checkResponse.ok) {
      continue;
    }

    const checkResult = await checkResponse.json();
    const outputUrl = checkResult?.result?.output_url;
    if (outputUrl) {
      return outputUrl;
    }
  }

  throw new Error("Proses timeout atau gagal.");
}

async function startFamily100Game(message, activeClient = client) {
  const chatId = message.from;
  const gameId = getFamily100SessionId(activeClient, chatId);

  if (family100Games.has(gameId)) {
    await message.reply("Masih ada kuis Family100 yang belum selesai di chat ini.");
    return;
  }

  const questions = loadFamily100Questions();
  if (questions.length === 0) {
    await message.reply("Soal Family100 belum tersedia. Isi dulu file json/family100.json.");
    return;
  }

  const selectedQuestion = questions[Math.floor(Math.random() * questions.length)];
  const answers = Array.isArray(selectedQuestion?.jawaban)
    ? selectedQuestion.jawaban.map((answer) => normalizeGameText(answer)).filter(Boolean)
    : [];

  if (!selectedQuestion?.soal || answers.length === 0) {
    await message.reply("Soal Family100 tidak valid. Cek isi file json/family100.json.");
    return;
  }

  const caption = [
    `*SOAL:* ${selectedQuestion.soal}`,
    `Terdapat *${answers.length}* jawaban`,
    "",
    `+${FAMILY100_WIN_SCORE} XP tiap jawaban benar`,
    "Waktu: 2 menit",
    "Ketik *nyerah* untuk menyerah",
  ].join("\n");

  await message.reply(caption);

  const timeoutId = setTimeout(async () => {
    const game = family100Games.get(gameId);
    if (!game) {
      return;
    }

    family100Games.delete(gameId);
    await safeSendMessage(
      chatId,
      [
        "*Waktu habis!*",
        "",
        `*Soal:* ${game.soal}`,
        "",
        "Jawaban:",
        formatFamily100Answers(game.jawaban),
      ].join("\n"),
      undefined,
      activeClient,
    );
  }, FAMILY100_TIME_LIMIT);

  family100Games.set(gameId, {
    soal: selectedQuestion.soal,
    jawaban: answers,
    terjawab: Array(answers.length).fill(null),
    timeoutId,
  });
}

async function handleFamily100Answer(message, activeClient = client) {
  const gameId = getFamily100SessionId(activeClient, message.from);
  const game = family100Games.get(gameId);
  if (!game) {
    return false;
  }

  const text = normalizeGameText(message.body);
  if (!text || text.startsWith(PREFIX)) {
    return false;
  }

  if (/^((me)?nyerah|surr?ender)$/i.test(text)) {
    clearTimeout(game.timeoutId);
    family100Games.delete(gameId);
    await message.reply(
      [
        "*MENYERAH!*",
        "",
        "Jawaban:",
        formatFamily100Answers(game.jawaban),
      ].join("\n"),
    );
    return true;
  }

  const matchedIndex = game.jawaban.findIndex(
    (answer) => similarityScore(answer, text) >= FAMILY100_MATCH_THRESHOLD,
  );

  if (matchedIndex < 0) {
    const unanswered = game.jawaban.filter((_, index) => !game.terjawab[index]);
    if (unanswered.length > 0) {
      const bestSimilarity = Math.max(
        ...unanswered.map((answer) => similarityScore(answer, text)),
      );
      if (bestSimilarity >= FAMILY100_NEAR_THRESHOLD) {
        await message.reply("Dikit lagi!");
      }
    }
    return true;
  }

  if (game.terjawab[matchedIndex]) {
    return true;
  }

  const participantId = message.author || message.from;
  const userProfile = ensureUserProfile(participantId);
  game.terjawab[matchedIndex] = participantId;

  if (userProfile) {
    userProfile.exp += FAMILY100_WIN_SCORE;
    saveDatabase();
  }

  const isWin = game.terjawab.every(Boolean);
  const caption = [
    `*Soal:* ${game.soal}`,
    "",
    isWin ? "*SEMUA JAWABAN TERJAWAB*" : "",
    game.jawaban
      .map((answer, index) => {
        const winnerId = game.terjawab[index];
        return winnerId ? `(${index + 1}) ${answer} @${winnerId.split("@")[0]}` : "";
      })
      .filter(Boolean)
      .join("\n"),
    "",
    `+${FAMILY100_WIN_SCORE} XP tiap jawaban benar`,
  ]
    .filter(Boolean)
    .join("\n");

  await safeSendMessage(message.from, caption, {
    mentions: game.terjawab.filter(Boolean),
  }, activeClient);

  if (isWin) {
    clearTimeout(game.timeoutId);
    family100Games.delete(gameId);
  }

  return true;
}

function getMenuText() {
  const modeLabel = isPublicMode ? "Public" : "Self";

  return [
    `╭─〔 ${BOT_NAME} 〕`,
    `│ Owner : ${OWNER_NAME}`,
    `│ Nomor : ${OWNER_NUMBER}`,
    `│ Bot   : ${BOT_NUMBER}`,
    `│ Mode  : ${modeLabel}`,
    "╰──────────────",
    "",
    "Halo, ini daftar menu yang bisa dipakai.",
    "Pilih command sesuai kebutuhanmu.",
    "",
    "┌〔 Menu Cepat 〕",
    `• ${PREFIX}menu`,
    `• ${PREFIX}gamemenu`,
    `• ${PREFIX}jadibot`,
    `• ${PREFIX}owner`,
    `• ${PREFIX}ping`,
    "└──────────────",
    "",
    "┌〔 Menu Utama 〕",
    `• ${PREFIX}ping  cek respons bot`,
    `• ${PREFIX}echo <teks>`,
    `• ${PREFIX}simi <teks>`,
    `• ${PREFIX}info`,
    `• ${PREFIX}jadibot <nomor>`,
    `• ${PREFIX}antilink on/off`,
    "└──────────────",
    "",
    "┌〔 Game 〕",
    `• ${PREFIX}family100`,
    `• ${PREFIX}gamemenu`,
    "└──────────────",
    "",
    "┌〔 Download 〕",
    `• ${PREFIX}tt <url/kata kunci>`,
    `• ${PREFIX}spotifyplay <judul lagu>`,
    `• ${PREFIX}play <judul lagu>`,
    `• ${PREFIX}ytmp3 <url>`,
    `• ${PREFIX}ytmp4 <url>`,
    `• ${PREFIX}dlit <platform> <url>`,
    "└──────────────",
    "",
    "┌〔 Tools 〕",
    `• ${PREFIX}s`,
    `• ${PREFIX}brat <teks>`,
    `• ${PREFIX}animebrat <teks>`,
    `• ${PREFIX}hdvideo`,
    `• ${PREFIX}tourl`,
    "└──────────────",
    "",
    "┌〔 Owner 〕",
    `• ${PREFIX}ownermenu`,
    `• ${PREFIX}listjadibot`,
    "└──────────────",
    "",
    `Ketik ${PREFIX}dlmenu untuk daftar download yang lebih detail.`,
  ].join("\n");
}

function getMenuBannerMedia() {
  if (!fs.existsSync(MENU_BANNER_PATH)) {
    return null;
  }

  return MessageMedia.fromFilePath(MENU_BANNER_PATH);
}

function getJadiBotClientId(requesterId) {
  return `jadibot-${normalizeNumber(requesterId)}`;
}

function formatPairingCode(code) {
  return String(code || "")
    .replace(/\s+/g, "")
    .match(/.{1,4}/g)
    ?.join("-") || String(code || "");
}

function createClientOptions(customClientId, pairingPhoneNumber) {
  return {
    authStrategy: new LocalAuth({
      clientId: customClientId,
    }),
    webVersionCache: {
      type: "none",
    },
    ...(pairingPhoneNumber
      ? {
          pairWithPhoneNumber: {
            phoneNumber: pairingPhoneNumber,
            showNotification: SHOW_PAIRING_NOTIFICATION,
            intervalMs: PAIRING_INTERVAL_MS,
          },
        }
      : {}),
    puppeteer: {
      headless: true,
      ...(browserExecutablePath
        ? {
            executablePath: browserExecutablePath,
          }
        : {}),
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  };
}

async function startJadiBotSession(message, inputNumber) {
  const requesterId = normalizeNumber(message.author || message.from);
  if (!requesterId) {
    await message.reply("Gagal membaca pengirim untuk sesi jadibot.");
    return;
  }

  if (jadibotClients.has(requesterId)) {
    await message.reply(
      "Sesi jadibot kamu masih aktif. Pakai .stopjadibot dulu kalau mau ganti sesi.",
    );
    return;
  }

  const phoneNumber = normalizeNumber(inputNumber || requesterId);
  if (!phoneNumber) {
    await message.reply(`Contoh penggunaan: ${PREFIX}jadibot 628xxxxxxxxxx`);
    return;
  }

  const session = {
    ownerId: requesterId,
    ownerChatId: message.from,
    phoneNumber,
    clientId: getJadiBotClientId(requesterId),
    client: null,
    ready: false,
    stopping: false,
  };

  const subClient = new Client(createClientOptions(session.clientId, phoneNumber));
  session.client = subClient;
  jadibotClients.set(requesterId, session);

  const cleanupSession = async (notifyText) => {
    const currentSession = jadibotClients.get(requesterId);
    if (currentSession?.client === subClient) {
      jadibotClients.delete(requesterId);
    }

    if (notifyText) {
      try {
        await safeSendMessage(session.ownerChatId, notifyText, undefined, client);
      } catch (error) {
        logStage("WARN", `Gagal mengirim notifikasi jadibot: ${error.message}`);
      }
    }
  };

  subClient.on("code", async (code) => {
    await safeSendMessage(
      session.ownerChatId,
      [
        "*Jadibot Pairing Code*",
        "",
        `Nomor: ${phoneNumber}`,
        `Kode: ${formatPairingCode(code)}`,
        "",
        "Masukkan kode ini di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon.",
      ].join("\n"),
      undefined,
      client,
    );
  });

  subClient.on("qr", async () => {
    await safeSendMessage(
      session.ownerChatId,
      "QR jadibot terdeteksi. Kalau pairing code belum muncul, tunggu sebentar lalu cek terminal bot utama.",
      undefined,
      client,
    );
  });

  subClient.on("ready", async () => {
    session.ready = true;
    logStage("JADIBOT", `Sesi ${requesterId} siap dipakai.`);
    await safeSendMessage(
      session.ownerChatId,
      [
        "*Jadibot aktif*",
        "",
        `Nomor: ${phoneNumber}`,
        "Sesi bot baru sudah terhubung dan siap dipakai.",
        `Gunakan ${PREFIX}stopjadibot untuk menghentikan sesi ini.`,
      ].join("\n"),
      undefined,
      client,
    );
  });

  subClient.on("auth_failure", async (authMessage) => {
    logStage("JADIBOT", `Auth gagal untuk ${requesterId}: ${authMessage}`);
    await cleanupSession(`Jadibot gagal login: ${authMessage}`);
  });

  subClient.on("disconnected", async (reason) => {
    logStage("JADIBOT", `Sesi ${requesterId} terputus: ${reason}`);
    await cleanupSession(
      session.stopping ? null : `Sesi jadibot terputus: ${reason}`,
    );
  });

  registerClientMessageHandler(subClient, {
    isPrimary: false,
  });

  await message.reply(
    `Menyiapkan jadibot untuk nomor ${phoneNumber}. Tunggu pairing code dikirim...`,
  );

  try {
    await subClient.initialize();
  } catch (error) {
    await cleanupSession(`Gagal memulai jadibot: ${error.message}`);
    throw error;
  }
}

async function stopJadiBotSession(requesterId) {
  const normalizedRequesterId = normalizeNumber(requesterId);
  const session = jadibotClients.get(normalizedRequesterId);

  if (!session) {
    return false;
  }

  jadibotClients.delete(normalizedRequesterId);
  session.stopping = true;

  try {
    await session.client.destroy();
  } catch (error) {
    logStage("WARN", `Gagal destroy sesi jadibot ${normalizedRequesterId}: ${error.message}`);
  }

  return true;
}

function getJadiBotListText() {
  const sessions = Array.from(jadibotClients.values());

  if (sessions.length === 0) {
    return "*List Jadibot*\n\nBelum ada sesi jadibot aktif.";
  }

  return [
    "*List Jadibot*",
    "",
    ...sessions.map(
      (session, index) =>
        `${index + 1}. ${session.phoneNumber} - ${session.ready ? "aktif" : "menunggu login"}`,
    ),
  ].join("\n");
}

function registerClientMessageHandler(activeClient, options = {}) {
  const { isPrimary = false } = options;

  activeClient.on("message", async (message) => {
    const sendCurrentMessage = (chatId, content, sendOptions) =>
      safeSendMessage(chatId, content, sendOptions, activeClient);

    try {
      if (message.from === STATUS_BROADCAST_ID) {
        if (isPrimary) {
          logBlockedStatusMessage();
        }
        return;
      }

      if (!isPublicMode && !(await isOwner(message))) {
        return;
      }

      const antiLinkResult = await shouldBlockGroupLink(activeClient, message);
      if (antiLinkResult.shouldBlock) {
        await message.reply(
          [
            "*Tautan grup terdeteksi*",
            "",
            "Kami tidak mengizinkan link dari grup lain di sini.",
            antiLinkResult.isBotAdmin
              ? "Pesan akan saya hapus karena anti-link aktif."
              : "Saya bukan admin, jadi saya belum bisa menghapus pesan ini.",
          ].join("\n"),
        );

        if (antiLinkResult.isBotAdmin) {
          try {
            await message.delete(true);
          } catch (error) {
            logStage(
              "WARN",
              `Gagal menghapus pesan anti-link di ${message.from}: ${error.message}`,
            );
          }
        }
        return;
      }

      if (await handleFamily100Answer(message, activeClient)) {
        return;
      }

      if (!message.body.startsWith(PREFIX)) {
        return;
      }

      const args = message.body.slice(PREFIX.length).trim().split(/\s+/);
      const command = (args.shift() || "").toLowerCase();

      switch (command) {
      case "ping":
        await message.reply("pong");
        break;

      case "family100":
        await startFamily100Game(message, activeClient);
        break;

      case "jadibot":
        if (!isPrimary) {
          await message.reply("Perintah ini hanya bisa dipakai dari bot utama.");
          return;
        }

        await startJadiBotSession(message, args[0]);
        break;

      case "stopjadibot": {
        const requesterId = normalizeNumber(message.author || message.from);
        if (!requesterId) {
          await message.reply("Gagal membaca sesi jadibot kamu.");
          return;
        }

        const stopped = await stopJadiBotSession(requesterId);
        await message.reply(
          stopped
            ? "Sesi jadibot berhasil dihentikan."
            : "Kamu belum punya sesi jadibot yang aktif.",
        );
        break;
      }

      case "listjadibot":
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        await message.reply(getJadiBotListText());
        break;

      case "menu":
      case "help": {
        const menuText = getMenuText();
        const menuBanner = getMenuBannerMedia();

        if (menuBanner) {
          await sendCurrentMessage(message.from, menuBanner, {
            caption: menuText,
          });
          break;
        }

        await message.reply(menuText);
        break;
      }

      case "gamemenu":
        await message.reply(
          [
            "*Menu Game*",
            "",
            `${PREFIX}family100 - mulai game tebak jawaban`,
            `${PREFIX}jadibot <nomor> - buat sesi bot baru`,
          ].join("\n"),
        );
        break;

      case "dlmenu":
        await message.reply(
          [
            "*Menu Download*",
            "",
            `${PREFIX}tt <url atau kata kunci>`,
            `${PREFIX}spotifyplay <judul lagu>`,
            `${PREFIX}play <judul lagu>`,
            `${PREFIX}ytmp3 <url YouTube>`,
            `${PREFIX}ytmp4 <url YouTube>`,
            `${PREFIX}dlit <platform> <url>`,
            "",
            "Contoh:",
            `${PREFIX}tt https://vt.tiktok.com/...`,
            `${PREFIX}tt elaina edit`,
            `${PREFIX}spotifyplay Payung Teduh Mari Bercerita`,
            `${PREFIX}play peterpan mungkin nanti`,
            `${PREFIX}dlit tiktok https://vt.tiktok.com/...`,
          ].join("\n"),
        );
        break;

      case "ownermenu":
        if (!(await isOwner(message))) {
          await message.reply("Menu ini hanya untuk owner bot.");
          return;
        }

        await message.reply(
          [
            "*Menu Owner*",
            "",
            `${PREFIX}ownermenu - tampilkan menu owner`,
            `${PREFIX}self - bot hanya merespons owner`,
            `${PREFIX}public - bot merespons semua user`,
            `${PREFIX}status - cek mode bot`,
            `${PREFIX}addowner 628xxx - tambah owner`,
            `${PREFIX}addprem 628xxx - tambah premium`,
            `${PREFIX}family100 - mulai game tebak jawaban`,
            `${PREFIX}listjadibot - lihat sesi jadibot aktif`,
            `${PREFIX}antilink on/off - nyala/matikan anti-link grup`,
            "",
            `Jumlah owner: ${database.owners.length}`,
            `Jumlah premium: ${database.premiums.length}`,
          ].join("\n"),
        );
        break;

      case "echo":
        if (args.length === 0) {
          await message.reply(`Contoh penggunaan: ${PREFIX}echo halo`);
          return;
        }
        await message.reply(args.join(" "));
        break;

      case "simi":
      case "simisimi": {
        if (args.length === 0) {
          await message.reply(`Contoh penggunaan: ${PREFIX}simi halo`);
          return;
        }

        const simiReply = await getSimiReply(args.join(" "));
        await message.reply(simiReply);
        break;
      }

      case "dlit": {
        if (args.length < 2) {
          await message.reply(
            `Contoh:\n${PREFIX}dlit tiktok https://vt.tiktok.com/ZSBKKk4HS/`,
          );
          return;
        }

        const platform = String(args[0] || "").toLowerCase();
        const inputUrl = args.slice(1).join(" ").trim();

        if (!["instagram", "tiktok", "facebook"].includes(platform)) {
          await message.reply(
            "Platform tidak valid. Gunakan: instagram, tiktok, atau facebook",
          );
          return;
        }

        await message.reply(
          `Sedang mengambil media dari ${platform}, tunggu sebentar...`,
        );
        if (platform === "tiktok") {
          const result = await getTikTokDownloadResult(inputUrl);

          if (result.images.length > 0) {
            for (const [index, imageUrl] of result.images.entries()) {
              const media = await MessageMedia.fromUrl(imageUrl, {
                unsafeMime: true,
                filename: `tiktok-photo-${index + 1}.jpg`,
              });
              await sendCurrentMessage(message.from, media, {
                caption:
                  index === 0
                    ? [
                        "*TIKTOK PHOTO*",
                        `Judul: ${result.title}`,
                        `Uploader: ${result.authorName}`,
                        `Total Foto: ${result.images.length}`,
                        `Views: ${result.views}`,
                      ].join("\n")
                    : "",
                sendMediaAsDocument: false,
              });
              if (index < result.images.length - 1) {
                await new Promise((resolve) => setTimeout(resolve, 3000));
              }
            }
            break;
          }

          const videoMedia = await MessageMedia.fromUrl(result.videoUrl, {
            unsafeMime: true,
            filename: "tiktok-video.mp4",
          });
          await sendCurrentMessage(message.from, videoMedia, {
            caption: [
              "*TIKTOK VIDEO*",
              `Judul: ${result.title}`,
              `Uploader: ${result.authorName}`,
              `Durasi: ${result.duration}`,
              `Views: ${result.views}`,
            ].join("\n"),
            sendMediaAsDocument: false,
          });

          if (result.audioUrl) {
            const audioMedia = await MessageMedia.fromUrl(result.audioUrl, {
              unsafeMime: true,
              filename: `${sanitizeFileName(result.title || "tiktok")}.mp3`,
            });
            await sendCurrentMessage(message.from, audioMedia, {
              sendAudioAsVoice: false,
            });
          }
          break;
        }

        const downloads = await downloadSocialMedia(platform, inputUrl);

        for (const [index, link] of downloads.entries()) {
          const media = await MessageMedia.fromUrl(link, {
            unsafeMime: true,
            filename: `media-${index + 1}.mp4`,
          });
          await sendCurrentMessage(message.from, media, {
            caption:
              downloads.length === 1
                ? `Berhasil download dari ${platform}`
                : `Hasil ${index + 1}/${downloads.length} dari ${platform}`,
            sendMediaAsDocument: false,
          });
        }
        break;
      }

      case "tt":
      case "ttdl":
      case "tiktok": {
        const input = message.hasQuotedMsg
          ? String((await message.getQuotedMessage()).body || "").trim() || args.join(" ").trim()
          : args.join(" ").trim();

        if (!input) {
          await message.reply(
            [
              "Contoh:",
              `${PREFIX}${command} https://vt.tiktok.com/xxxx`,
              `${PREFIX}${command} elaina edit`,
            ].join("\n"),
          );
          return;
        }

        await message.reply("Sedang mengambil data TikTok, tunggu sebentar...");
        const result = await getTikTokDownloadResult(input);

        if (result.images.length > 0) {
          for (const [index, imageUrl] of result.images.entries()) {
            const media = await MessageMedia.fromUrl(imageUrl, {
              unsafeMime: true,
              filename: `tiktok-photo-${index + 1}.jpg`,
            });
            await sendCurrentMessage(message.from, media, {
              caption:
                index === 0
                  ? [
                      "*TIKTOK PHOTO*",
                      `Judul: ${result.title}`,
                      `Uploader: ${result.authorName}`,
                      `Total Foto: ${result.images.length}`,
                      `Views: ${result.views}`,
                    ].join("\n")
                  : "",
              sendMediaAsDocument: false,
            });

            if (index < result.images.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
          }
          break;
        }

        const videoMedia = await MessageMedia.fromUrl(result.videoUrl, {
          unsafeMime: true,
          filename: "tiktok-video.mp4",
        });
        await sendCurrentMessage(message.from, videoMedia, {
          caption: [
            "*TIKTOK VIDEO*",
            `Judul: ${result.title}`,
            `Uploader: ${result.authorName}`,
            `Durasi: ${result.duration}`,
            `Views: ${result.views}`,
          ].join("\n"),
          sendMediaAsDocument: false,
        });

        if (result.audioUrl) {
          const audioMedia = await MessageMedia.fromUrl(result.audioUrl, {
            unsafeMime: true,
            filename: `${sanitizeFileName(result.title || "tiktok")}.mp3`,
          });
          await sendCurrentMessage(message.from, audioMedia, {
            sendAudioAsVoice: false,
          });
        }
        break;
      }

      case "play": {
        if (args.length === 0) {
          await message.reply(
            `Contoh penggunaan: ${PREFIX}play everything u are`,
          );
          return;
        }

        const query = args.join(" ");
        await message.reply("Sedang mencari lagu, tunggu sebentar...");
        const video = await searchYouTubeVideo(query);

        const detail = [
          `Judul: ${video.title || "-"}`,
          `Durasi: ${video.timestamp || "-"}`,
          `Views: ${video.views ? formatNumber(video.views) : "-"}`,
          `Channel: ${video.author?.name || "-"}${video.author?.verified ? " [verified]" : ""}`,
          `Upload: ${video.ago || "-"}`,
          "",
          `Gunakan ${PREFIX}ytmp3 ${video.url}`,
          `Gunakan ${PREFIX}ytmp4 ${video.url}`,
        ].join("\n");

        if (video.thumbnail) {
          const thumb = await MessageMedia.fromUrl(video.thumbnail, {
            unsafeMime: true,
            filename: "thumbnail.jpg",
          });
          await sendCurrentMessage(message.from, thumb, {
            caption: detail,
          });
          break;
        }

        await message.reply(detail);
        break;
      }

      case "spotifyplay":
      case "spplay": {
        if (args.length === 0) {
          await message.reply(
            `Contoh:\n${PREFIX}${command} Payung Teduh Mari Bercerita`,
          );
          return;
        }

        await message.reply("Sedang mencari lagu Spotify, tunggu sebentar...");
        const spotify = await getSpotifyPlayResult(args.join(" "));
        const caption = [
          "Spotify Play",
          `Title: ${spotify.title || "-"}`,
          `Artist: ${spotify.artist || "-"}`,
          `Album: ${spotify.album || "-"}`,
          `Duration: ${spotify.duration || "-"}`,
          `Popular: ${formatFullNumber(spotify.popularity)}`,
          `Release: ${spotify.release_at || "-"}`,
        ].join("\n");

        if (spotify.thumbnail) {
          const thumbnailMedia = await MessageMedia.fromUrl(spotify.thumbnail, {
            unsafeMime: true,
            filename: "spotify.jpg",
          });
          await sendCurrentMessage(message.from, thumbnailMedia, {
            caption,
          });
        } else {
          await message.reply(caption);
        }

        const audioMedia = await MessageMedia.fromUrl(spotify.download_url, {
          unsafeMime: true,
          filename: `${sanitizeFileName(spotify.title || "spotify")}.mp3`,
        });
        await sendCurrentMessage(message.from, audioMedia, {
          sendAudioAsVoice: false,
        });
        break;
      }

      case "ytmp3": {
        if (args.length === 0) {
          await message.reply(
            `Contoh penggunaan: ${PREFIX}ytmp3 https://www.youtube.com/watch?v=xxxx`,
          );
          return;
        }

        const url = args[0];
        await message.reply("Sedang menyiapkan audio YouTube, tunggu sebentar...");
        const media = await createYouTubeAudioMediaFromUrl(
          url,
          "youtube-audio",
        );
        await sendCurrentMessage(message.from, media, {
          sendAudioAsVoice: false,
        });
        break;
      }

      case "ytmp4": {
        if (args.length === 0) {
          await message.reply(
            `Contoh penggunaan: ${PREFIX}ytmp4 https://www.youtube.com/watch?v=xxxx`,
          );
          return;
        }

        const url = args[0];
        await message.reply("Sedang menyiapkan video YouTube, tunggu sebentar...");
        const media = await createYouTubeVideoMediaFromUrl(
          url,
          "youtube-video",
        );
        await sendCurrentMessage(message.from, media, {
          caption: "*YouTube Video*",
          sendMediaAsDocument: false,
        });
        break;
      }

      case "owner":
      case "ownerbot":
        await message.reply(
          [
            `Nama owner: ${OWNER_NAME}`,
            `Nomor owner: ${OWNER_NUMBER}`,
            `Nama bot: ${BOT_NAME}`,
            `Nomor bot: ${BOT_NUMBER}`,
          ].join("\n"),
        );
        break;

      case "s":
      case "sticker": {
        const media = await getImageMediaFromMessage(message);
        if (!media) {
          await message.reply(
            `Kirim gambar dengan caption ${PREFIX}s atau reply gambar lalu kirim ${PREFIX}s`,
          );
          return;
        }

        await sendCurrentMessage(message.from, media, {
          sendMediaAsSticker: true,
          stickerName: "Bot WA Node",
          stickerAuthor: "Akmal Bot",
        });
        break;
      }

      case "tourl": {
        const media = await getMediaFromMessage(message);
        if (!media) {
          await message.reply("Reply/kirim file yang mau diupload.");
          return;
        }

        await message.reply("Sedang upload media ke CDN, tunggu sebentar...");
        const url = await uploadMediaToCdn(media);
        await message.reply(
          [
            "*Berhasil Upload ke CDN!*",
            "",
            url,
          ].join("\n"),
        );
        break;
      }

      case "brat": {
        const bratText = await resolveBratText(message, args);
        if (!bratText) {
          await message.reply("Reply teks atau masukkan teks untuk dibuat jadi sticker brat.");
          return;
        }

        await message.reply("Sedang membuat sticker brat, tunggu sebentar...");
        const bratSticker = await createBratSticker(bratText);
        await sendCurrentMessage(message.from, bratSticker, {
          sendMediaAsSticker: true,
          stickerName: "Sticker Pack",
          stickerAuthor: "Bot",
        });
        break;
      }

      case "animebrat": {
        if (args.length === 0) {
          await message.reply(`Contoh penggunaan: ${PREFIX}animebrat halo`);
          return;
        }

        await message.reply("Sedang membuat sticker animebrat, tunggu sebentar...");
        const stickerMedia = await createAnimeBratMedia(args.join(" "));

        await sendCurrentMessage(message.from, stickerMedia, {
          sendMediaAsSticker: true,
          stickerName: " ",
          stickerAuthor: "hanzxd",
        });
        break;
      }

      case "hdvideo":
      case "unblurvideo":
      case "vhd": {
        const media = await getQuotedOrOwnMedia(message);
        if (!media || !String(media.mimetype || "").startsWith("video/")) {
          await message.reply(
            `Balas video dengan perintah ${PREFIX}${command || "hdvideo"}`,
          );
          return;
        }

        await message.reply(
          "Sedang memproses video, mohon tunggu sebentar. Proses ini bisa memakan waktu beberapa menit...",
        );

        const outputUrl = await enhanceVideoToHd(media);
        const enhancedVideo = await MessageMedia.fromUrl(outputUrl, {
          unsafeMime: true,
          filename: "hdvideo.mp4",
        });
        await sendCurrentMessage(message.from, enhancedVideo, {
          caption: "Video berhasil di-enhance (2K).",
          sendMediaAsDocument: false,
        });
        break;
      }

      case "info": {
        const chat = await message.getChat();
        const contact = await message.getContact();
        const groupSettings = chat.isGroup ? getGroupSettings(message.from) : null;
        const info = [
          "*Informasi Chat*",
          `Nama: ${contact.pushname || contact.name || "Tidak diketahui"}`,
          `Nomor: ${contact.number || "Tidak diketahui"}`,
          `Tipe chat: ${chat.isGroup ? "Grup" : "Pribadi"}`,
        ];

        if (chat.isGroup) {
          info.push(`Nama grup: ${chat.name}`);
          info.push(`Jumlah peserta: ${chat.participants.length}`);
          info.push(`Anti-link: ${groupSettings?.antiLink ? "aktif" : "mati"}`);
        }

        await message.reply(info.join("\n"));
        break;
      }

      case "antilink": {
        const chat = await message.getChat();
        if (!chat.isGroup) {
          await message.reply("Perintah ini hanya bisa dipakai di dalam grup.");
          return;
        }

        const { isSenderAdmin } = await getGroupAdminState(activeClient, message);
        if (!(await isOwner(message)) && !isSenderAdmin) {
          await message.reply(
            "Hanya owner bot atau admin grup yang bisa mengubah anti-link.",
          );
          return;
        }

        const action = String(args[0] || "").toLowerCase();
        if (!["on", "off"].includes(action)) {
          await message.reply(`Contoh penggunaan: ${PREFIX}antilink on`);
          return;
        }

        const groupSettings = getGroupSettings(message.from);
        groupSettings.antiLink = action === "on";
        saveDatabase();
        await message.reply(
          `Anti-link grup sekarang ${groupSettings.antiLink ? "aktif" : "mati"}.`,
        );
        break;
      }

      case "self":
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        isPublicMode = false;
        await message.reply(
          "Mode bot diubah ke self. Hanya owner yang bisa memakai command.",
        );
        break;

      case "public":
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        isPublicMode = true;
        await message.reply(
          "Mode bot diubah ke public. Semua user bisa memakai command.",
        );
        break;

      case "status":
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        await message.reply(
          [
            "*Status Bot*",
            `Mode: ${isPublicMode ? "public" : "self"}`,
            `Nama bot: ${BOT_NAME}`,
            `Nomor bot: ${BOT_NUMBER}`,
            `Owner utama: ${OWNER_NAME} (${OWNER_NUMBER})`,
            `Total owner: ${database.owners.length}`,
            `Total premium: ${database.premiums.length}`,
          ].join("\n"),
        );
        break;

      case "addowner": {
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        const target = normalizeNumber(args[0]);
        if (!target) {
          await message.reply(
            `Contoh penggunaan: ${PREFIX}addowner 628123456789`,
          );
          return;
        }

        if (database.owners.includes(target)) {
          await message.reply("Nomor itu sudah terdaftar sebagai owner.");
          return;
        }

        database.owners.push(target);
        saveDatabase();
        await message.reply(`Berhasil menambahkan owner baru: ${target}`);
        break;
      }

      case "addprem":
      case "addpremium": {
        if (!(await isOwner(message))) {
          await message.reply("Perintah ini hanya untuk owner bot.");
          return;
        }

        const target = normalizeNumber(args[0]);
        if (!target) {
          await message.reply(
            `Contoh penggunaan: ${PREFIX}addprem 628123456789`,
          );
          return;
        }

        if (database.premiums.includes(target)) {
          await message.reply("Nomor itu sudah terdaftar sebagai premium.");
          return;
        }

        database.premiums.push(target);
        saveDatabase();
        await message.reply(`Berhasil menambahkan user premium: ${target}`);
        break;
      }

      default:
        await message.reply(
          `Perintah tidak dikenal. Ketik ${PREFIX}menu untuk melihat daftar command.`,
        );
    }
  } catch (error) {
    console.error("Terjadi error saat memproses pesan:", error);
    await message.reply("Maaf, terjadi error saat memproses perintah.");
  }
  });
}

registerClientMessageHandler(client, {
  isPrimary: true,
});

client.initialize();
