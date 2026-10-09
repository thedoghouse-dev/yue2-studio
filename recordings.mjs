import { createWriteStream, unlinkSync, existsSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX = 128 * 1024 * 1024;
const headers = { 'User-Agent': 'YuE2Studio/1.0 (local public-domain audio finder)' };
const clean = value => String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&(?:amp|quot|lt|gt|#39);/g, x => ({'&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>','&#39;':"'"})[x]).replace(/\s+/g, ' ').trim().slice(0, 1500);
function error(message, status=502) { throw Object.assign(new Error(message), {status}); }
export function safeMedia(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'upload.wikimedia.org' || url.port || url.username || url.password || !url.pathname.startsWith('/wikipedia/commons/')) error('Unsupported audio source.',400);
  return url.href;
}
export function recording(page) {
  const info = page.imageinfo?.[0], meta = info?.extmetadata;
  if (!info || !meta || page.ns !== 6) return null;
  const license = clean(meta.LicenseShortName?.value), code=clean(meta.License?.value);
  const pd = license.toLowerCase() === 'public domain' && code === 'pd' && String(meta.Copyrighted?.value).toLowerCase() === 'false';
  const cc0 = /^cc0(?: 1\.0)?$/i.test(license) && /^cc-zero$/i.test(code);
  if ((!pd && !cc0) || clean(meta.Restrictions?.value) || /disput|deletion requests|copyright violations|license review needed/i.test(meta.Categories?.value ?? '')) return null;
  const extension = new URL(info.url).pathname.match(/\.(wav|mp3|flac|m4a|ogg|oga|aac|aiff|aif|opus)$/i)?.[1]?.toLowerCase();
  if (!extension || !(info.mime?.startsWith('audio/') || info.mime === 'application/ogg') || info.mime === 'audio/midi' || info.width || info.height || info.size < 12 || info.size > MAX) return null;
  let mediaUrl; try { mediaUrl=safeMedia(info.url); } catch { return null; }
  return {pageId:page.pageid,title:clean(meta.ObjectName?.value || page.title.replace(/^File:/,'')),creator:clean(meta.Artist?.value),description:clean(meta.ImageDescription?.value),license:cc0?'CC0 1.0':'Public domain',licenseUrl:cc0?'https://creativecommons.org/publicdomain/zero/1.0/':null,sourceUrl:`https://commons.wikimedia.org/?curid=${page.pageid}`,mediaUrl,extension:extension==='oga'?'ogg':extension,bytes:info.size,duration:info.duration??null,provider:'Wikimedia Commons'};
}
export function createRecordingSource(fetcher=fetch) {
  async function query(params) {
    const url = new URL('https://commons.wikimedia.org/w/api.php');
    url.search = new URLSearchParams({action:'query',format:'json',prop:'imageinfo',iiprop:'url|mime|size|extmetadata',...params});
    try {
      const response=await fetcher(url,{headers,signal:AbortSignal.timeout(20000),redirect:'error'});
      if (!response.ok) error(`Song search is unavailable (${response.status}). Try again later.`);
      const data=await response.json(); if(data.error) error('The source could not complete this search. Try a simpler song title.');
      return data;
    } catch(e) { if(e.status)throw e;error('Cannot reach Wikimedia Commons. Check your internet connection and try again.'); }
  }
  return {
    async search(term) {
      if(typeof term !== 'string'||!term.trim()||term.length>160)error('Enter a song title up to 160 characters.',400);
      // Quote the user's title so Commons search operators cannot change the audio filter.
      const phrase=term.replace(/["\\]/g,' ').trim();
      const results=[]; let continuation={}; let scanned=0;
      for(let i=0;i<3;i++) {
        const data=await query({generator:'search',gsrsearch:`"${phrase}" filetype:audio`,gsrnamespace:'6',gsrlimit:'50',...continuation});
        const pages=Object.values(data.query?.pages??{}).sort((a,b)=>a.index-b.index);scanned+=pages.length;
        for(const page of pages){const item=recording(page);if(item&&!results.some(r=>r.pageId===item.pageId))results.push(item);}
        if(!data.continue||results.length>=20)break;continuation=data.continue;
      }
      return {results:results.slice(0,20),scanned};
    },
    async resolve(id) {
      if(!Number.isSafeInteger(id)||id<=0)error('Choose a valid search result.',400);
      const data=await query({pageids:String(id)});const item=recording(data.query?.pages?.[id]??{});
      if(!item)error('This recording no longer has eligible public-domain or CC0 metadata.',409);
      return item;
    },
    async download(item,file) {
      try {
        const response=await fetcher(safeMedia(item.mediaUrl),{headers,signal:AbortSignal.timeout(120000),redirect:'error'});
        if(!response.ok||!response.body)error('The recording could not be downloaded. Try again later.');
        if(Number(response.headers.get('content-length'))>MAX)error('This audio exceeds the 128 MB limit.',413);
        const type=response.headers.get('content-type')??'';
        if(!/^(audio\/|application\/(ogg|octet-stream))/i.test(type))error('The source did not return an audio file.');
        let bytes=0;
        await pipeline(Readable.fromWeb(response.body),new Transform({transform(chunk,enc,cb){bytes+=chunk.length;cb(bytes>MAX?new Error('This audio exceeds the 128 MB limit.'):null,chunk);}}),createWriteStream(file));
        if(bytes<12||bytes!==item.bytes)error('The audio download was incomplete or changed. Search again.');
        return bytes;
      }catch(e){if(existsSync(file))unlinkSync(file);if(e.status)throw e;error('Audio download failed. Check your connection and try again.');}
    }
  };
}
