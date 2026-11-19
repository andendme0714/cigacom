'use strict';
// 유튜브 Data API v3 공식 엔드포인트만 사용합니다.
// Node 20+ 기본 모듈만 사용하여 설치 의존성이 없습니다.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.YOUTUBE_API_KEY || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const API_BASE = 'https://www.googleapis.com/youtube/v3';
const SEARCH_DAILY_BUDGET = 80; // 검색 일일 기본 100회 중 여유 20회 확보
const UPLOADS_REFRESH_MS = 10 * 60 * 1000;
const VIDEO_REFRESH_MS = 2 * 60 * 1000;
const SEARCH_REFRESH_MS = Math.ceil(24 * 60 * 60 * 1000 / SEARCH_DAILY_BUDGET);
const MAX_AGE_MS = 30 * 60 * 1000; // 30분 넘게 검증되지 않은 LIVE는 '확인 지연'으로 전환
const configured = JSON.parse(fs.readFileSync(path.join(__dirname, 'config/members.json'), 'utf8'));
const validId = id => /^UC[A-Za-z0-9_-]{22}$/.test(id);
const validHandle = handle => /^@[\p{L}\p{N}_.-]{3,30}$/u.test(handle);
const validVideoId = id => /^[A-Za-z0-9_-]{11}$/.test(id);
const members = configured.map((member, index) => ({
  id: String(member.id || `member_${index}`).replace(/[^a-zA-Z0-9_-]/g, ''),
  name: String(member.name || `멤버 ${index + 1}`),
  channelInput: String(member.channel || '').trim(),
  tag: String(member.tag || ''),
  channelId: null,
  uploadsPlaylist: null,
  recentUploadsFetched: false,
  channelUrl: null,
  status: 'setup',  // setup | checking | live | offline | error
  title: '', image: '', videoId: null,
  lastCheckedAt: null,
  error: ''
}));

// 서버 메모리에 저장. 무료 Render가 절전/재시작되면 다시 채워집니다.
let knownVideoIds = new Set();
let resolveAt = 0, uploadsAt = 0, videosAt = 0, searchAt = 0;
let searchCursor = 0;
let inFlight = null;
let lastSyncError = '';
let searchesToday = 0;
let quotaDay = '';
let searchBlockedUntilNextDay = false;
let quotaError = false;

function youtubeQuotaDay(date = new Date()) {
  // YouTube 쿼터는 미국 태평양 시간의 자정에 리셋됩니다.
  const pieces = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const out = Object.fromEntries(pieces.filter(p => p.type !== 'literal').map(p => [p.type,p.value]));
  return `${out.year}-${out.month}-${out.day}`;
}
function resetDailyBudget(now = new Date()) {
  const day = youtubeQuotaDay(now);
  if (quotaDay !== day) {
    quotaDay = day; searchesToday = 0;
    searchBlockedUntilNextDay = false; quotaError = false;
  }
}
function toChannelUrl(m) {
  return m.channelId ? `https://www.youtube.com/channel/${m.channelId}` :
    validHandle(m.channelInput) ? `https://www.youtube.com/${m.channelInput}` : '';
}
function thumbnail(item) {
  const ts = item?.snippet?.thumbnails || {};
  return (ts.high || ts.medium || ts.default)?.url || '';
}
function markLive(m, video) {
  m.status = 'live';
  m.title = String(video.snippet?.title || '라이브 방송 중');
  m.image = thumbnail(video) || `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
  m.videoId = video.id;
  m.lastCheckedAt = new Date().toISOString();
  m.error = '';
}
function markOffline(m) {
  m.status = 'offline'; m.title = ''; m.image = ''; m.videoId = null;
  m.lastCheckedAt = new Date().toISOString(); m.error = '';
}
function markFailure(m, message) {
  m.error = message;
  if (!m.lastCheckedAt) m.status = 'error';
  // 확실하지 않은 상태를 OFFLINE으로 덮어쓰지 않습니다.
}
function apiError(json, status) {
  const reason = json?.error?.errors?.[0]?.reason || json?.error?.status || 'API_ERROR';
  const message = json?.error?.message || `HTTP ${status}`;
  const error = new Error(`${reason}: ${message}`);
  error.reason = reason; error.status = status;
  return error;
}
async function youtube(endpoint, params) {
  if (!API_KEY) throw new Error('YOUTUBE_API_KEY가 설정되지 않았습니다.');
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, val] of Object.entries({ ...params, key: API_KEY })) url.searchParams.set(key, String(val));
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(18000) });
  let data;
  try { data = await response.json(); } catch { throw new Error('유튜브 API 응답을 읽을 수 없습니다.'); }
  if (!response.ok) {
    const err = apiError(data,response.status);
    if (['quotaExceeded','dailyLimitExceeded','rateLimitExceeded'].includes(err.reason)) quotaError = true;
    throw err;
  }
  return data;
}

async function resolveChannels() {
  const active = members.filter(m => m.channelInput && (validId(m.channelInput) || validHandle(m.channelInput)));
  // 유효하지 않은 입력은 UI에 설정 오류로 표시합니다.
  for (const m of members) {
    if (!m.channelInput) { m.status = 'setup'; m.error = '유튜브 채널 주소를 등록해주세요.'; }
    else if (!active.includes(m)) { m.status = 'error'; m.error = 'UC 채널 ID 또는 @핸들을 입력하세요.'; }
  }
  if (!active.length) return;
  const ids = [];
  for (const m of active) {
    try {
      if (validId(m.channelInput)) { m.channelId = m.channelInput; ids.push(m.channelId); }
      else {
        const json = await youtube('channels', {part:'id', forHandle:m.channelInput});
        m.channelId = json.items?.[0]?.id || null;
        if (!m.channelId) throw new Error('채널 핸들을 찾지 못했습니다.');
        ids.push(m.channelId);
      }
      m.channelUrl = toChannelUrl(m);
      if (m.status === 'setup' || m.status === 'error') m.status = 'checking';
      m.error = '';
    } catch (err) { m.status='error'; m.error=err.message; }
  }
  for (let i=0; i<ids.length; i+=50) {
    try {
      const response = await youtube('channels', { part:'contentDetails', id: ids.slice(i,i+50).join(',') });
      for (const ch of response.items || []) {
        const m = members.find(m => m.channelId===ch.id);
        if (m) m.uploadsPlaylist = ch.contentDetails?.relatedPlaylists?.uploads || null;
      }
    } catch (err) {
      lastSyncError = err.message;
      for (const m of members.filter(m=>ids.includes(m.channelId))) markFailure(m,err.message);
    }
  }
}

async function recentUploads() {
  const active = members.filter(m=>m.channelId && m.uploadsPlaylist);
  if (!active.length) return;
  const results = await Promise.allSettled(active.map(m => youtube('playlistItems', {
    part:'contentDetails', playlistId:m.uploadsPlaylist, maxResults:8
  })));
  for (let i=0;i<results.length;i++) {
    const result=results[i], m=active[i];
    if (result.status === 'fulfilled') {
      m.recentUploadsFetched = true;
      for (const item of result.value.items || []) {
        const id = item.contentDetails?.videoId;
        if (validVideoId(id)) knownVideoIds.add(id);
      }
    } else markFailure(m,result.reason.message);
  }
  // 캐시가 과도하게 늘어나는 것을 방지합니다.
  if (knownVideoIds.size > 500) knownVideoIds = new Set([...knownVideoIds].slice(-250));
}

async function inspectKnownVideos() {
  const candidates = [...knownVideoIds];
  if (!candidates.length) {
    for (const m of members.filter(m=>m.recentUploadsFetched && m.status==='checking')) markOffline(m);
    return;
  }
  const liveByChannel = new Map();
  let allChunksSucceeded = true;
  for (let i=0; i<candidates.length; i+=50) {
    try {
      const data = await youtube('videos', {
        part:'snippet,liveStreamingDetails', id:candidates.slice(i,i+50).join(',')
      });
      for (const video of data.items || []) {
        if (video?.snippet?.liveBroadcastContent === 'live' && validVideoId(video.id)) {
          const ownerId = video.snippet.channelId;
          if (!liveByChannel.has(ownerId)) liveByChannel.set(ownerId,video);
        }
      }
    } catch (err) { allChunksSucceeded=false; lastSyncError = err.message; }
  }
  for (const m of members) {
    if (!m.channelId) continue;
    const video = liveByChannel.get(m.channelId);
    if (video) markLive(m,video);
    else if (allChunksSucceeded && m.recentUploadsFetched && (m.status==='live' || m.status==='checking' || m.status==='offline')) markOffline(m);
    // 업로드 재생목록의 영상에서 LIVE를 못 찾은 경우도 임시로 OFFLINE 표시합니다.
    // 새 LIVE가 목록에 늦게 반영될 수 있으므로 정확한 발견은 순환 검색으로 보완합니다.
  }
}

async function searchOneChannel() {
  resetDailyBudget();
  const active = members.filter(m=>m.channelId);
  if (!active.length || searchesToday>=SEARCH_DAILY_BUDGET || searchBlockedUntilNextDay) return;
  // 라운드로빈으로 채널을 한 명씩 정확히 검색합니다.
  const m = active[searchCursor % active.length];
  searchCursor++;
  searchesToday++; // 실패한 호출도 쿼터를 쓸 수 있어 미리 카운트
  try {
    const json = await youtube('search', {
      part:'snippet', channelId:m.channelId, eventType:'live', type:'video', maxResults:5
    });
    const ids = (json.items || []).map(it => it.id?.videoId).filter(validVideoId);
    for (const id of ids) knownVideoIds.add(id);
    if (!ids.length) { markOffline(m); return; }
    const details = await youtube('videos', { part:'snippet,liveStreamingDetails', id:ids.join(',') });
    const live = (details.items||[]).find(v=>v.snippet?.channelId===m.channelId && v.snippet?.liveBroadcastContent==='live');
    if (live) markLive(m,live);
    else markOffline(m);
  } catch (err) {
    lastSyncError = err.message;
    markFailure(m,err.message);
    if (['quotaExceeded','dailyLimitExceeded','rateLimitExceeded'].includes(err.reason)) searchBlockedUntilNextDay = true;
  }
}

async function updateIfDue() {
  if (!API_KEY) return;
  if (inFlight) return inFlight;
  const now = Date.now();
  const due = !resolveAt || now-uploadsAt >= UPLOADS_REFRESH_MS || now-videosAt >= VIDEO_REFRESH_MS || now-searchAt >= SEARCH_REFRESH_MS;
  if (!due) return;
  inFlight = (async()=> {
    if (!resolveAt) { resolveAt=Date.now(); await resolveChannels(); }
    if (!uploadsAt || Date.now()-uploadsAt>=UPLOADS_REFRESH_MS) {
      uploadsAt=Date.now(); await recentUploads();
    }
    if (!videosAt || Date.now()-videosAt>=VIDEO_REFRESH_MS) {
      videosAt=Date.now(); await inspectKnownVideos();
    }
    if (!searchAt || Date.now()-searchAt>=SEARCH_REFRESH_MS) {
      searchAt=Date.now(); await searchOneChannel();
    }
  })().catch(err=>{lastSyncError=err.message; console.error('동기화 실패:',err.message);})
    .finally(()=> {inFlight=null;});
  return inFlight;
}
function exposedMember(m) {
  const last = m.lastCheckedAt ? Date.parse(m.lastCheckedAt) : 0;
  const stale = Boolean(last && Date.now()-last>MAX_AGE_MS);
  return {
    id:m.id, name:m.name, tag:m.tag,
    channelUrl:m.channelUrl || toChannelUrl(m),
    status: stale && ['live','offline'].includes(m.status) ? 'stale' : m.status,
    live: m.status==='live' && !stale,
    title: m.title, image:m.image,
    videoUrl: validVideoId(m.videoId) ? `https://www.youtube.com/watch?v=${m.videoId}` : '',
    lastCheckedAt:m.lastCheckedAt,
    message:m.status==='setup' ? m.error : (m.status==='error' ? m.error : (stale ? '마지막 LIVE 확인 결과가 오래되었습니다.' : ''))
  };
}
function statusPayload() {
  resetDailyBudget();
  return {
    mode: !API_KEY ? 'needs_api_key' : 'connected',
    members: members.map(exposedMember),
    serverTime:new Date().toISOString(),
    searchesToday, searchDailyBudget:SEARCH_DAILY_BUDGET,
    nextSearchAt: searchAt ? new Date(searchAt+SEARCH_REFRESH_MS).toISOString() : null,
    lastError: lastSyncError ? '일부 채널을 최신 상태로 확인하지 못했을 수 있습니다.' : '',
    note: '유튜브 검색 한도와 공개/비공개 설정에 따라 신규 LIVE 감지가 늦어질 수 있습니다.'
  };
}
function json(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(data));
}
function handleHttp(req,res) {
  const method = req.method || 'GET';
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (!['GET','HEAD'].includes(method)) return json(res,405,{error:'Method Not Allowed'});
  if (pathname==='/health') return json(res,200,{ok:true});
  if (pathname==='/api/live') {
    // 요청 시 상태 확인을 시작하되, 브라우저 응답은 캐시 상태를 즉시 반환합니다.
    // Render 무료 서버에서 앱이 꺼졌다가 깨어나도 재동기화를 시작합니다.
    void updateIfDue();
    return json(res,200,statusPayload());
  }
  let filePath;
  if (pathname==='/' || pathname==='/index.html') filePath=path.join(PUBLIC_DIR,'index.html');
  else if (/^\/assets\/[\w.-]+\.(jpg|jpeg|png|webp|svg)$/.test(pathname)) filePath=path.join(PUBLIC_DIR, pathname.slice(1));
  else return json(res,404,{error:'Not Found'});
  const ext = path.extname(filePath);
  const mime={'.html':'text/html; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.svg':'image/svg+xml'}[ext]||'application/octet-stream';
  fs.stat(filePath,(err,stats)=>{
    if (err || !stats.isFile()) return json(res,404,{error:'Not Found'});
    res.writeHead(200,{'Content-Type':mime,'Cache-Control':'public, max-age=300','X-Content-Type-Options':'nosniff'});
    if(method==='HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}
const server = http.createServer(handleHttp);
if (require.main===module) {
  server.listen(PORT,'0.0.0.0',()=>{
    console.log(`YouTube Live Label 서버 시작: http://localhost:${PORT}`);
    console.log('API 키:', API_KEY?'등록됨':'미설정 (예시 화면만 표시)');
  });
}
module.exports = { server, youtubeQuotaDay, validHandle, validId, validVideoId, exposedMember, statusPayload };
