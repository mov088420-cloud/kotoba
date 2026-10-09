/* Bump VERSION on every release and update the entire file set together. */
const VERSION = '1.3.2';
const PREFIX = `kotoba-shell-${encodeURIComponent(new URL(self.registration.scope).pathname)}-`;
const CACHE = PREFIX + VERSION;
// BEGIN GENERATED HASHES
const HASHES = {
  "./": "7da9867e873dce2237777a665f69c64511142edfcd24dcf5f6116ad436a25104",
  "./index.html": "7da9867e873dce2237777a665f69c64511142edfcd24dcf5f6116ad436a25104",
  "./styles.css": "789e154857ed1664118777df339a4f3b66607fdae13b6b451f86d2d10b0f5d5a",
  "./app.js": "d428203a98c4c0a1f801c533befb346652b8542c4209c5321f3a48dd84d14132",
  "./db.js": "607ce464bed6767e7ce82d2cc12fbfd9e50e717fb7513643bf3f1bf747b9e9f2",
  "./data.js": "19712c611f67ae6490d87fd23f1c5b2378d5f7180051378010e506be80e555b1",
  "./clibor.js": "9f52e490833a8115129928eceae162a79a79ab4fa8054ad5e109ecff3b281225",
  "./manifest.webmanifest": "06fffe78207fedc45e7794df5572c2b0ac7f093dd0b784bfbdb73e7fad8250a6",
  "./icons/icon.svg": "0b514ec2bac9c91204d61b5de5a090d7b18fa8e9e9e6d7f11a112e459be8309a",
  "./icons/icon-192.png": "84b8b7a1d4330f7b6a04059b9f96b0224e1c98027a6fb226689ef2f6fe2818d9",
  "./icons/icon-512.png": "254eb0c8ba3fdf2bd96ea7ed7caa27b08375416099bc0eb5146d22af1d2717b4",
  "./icons/apple-touch-icon.png": "1173f7f2d181530f5b91dec1d340cb72add051965c6f4975d351a7ef14500e8b",
  "./icons/startup-1170x2532.png": "9972913d6deee33d1bfe241d4642ad0fe5dc02fdc423c218fa78e9f2d5a434da",
  "./icons/startup-1179x2556.png": "7d589bdf6c0eb190264eb2c0109724f3194dbfb21b942ee6ee45f126389aa54f",
  "./icons/startup-750x1334.png": "ad2ac9988fd0394ed2b057491f979b9ab4b3902711431416c414645ba5a7326a"
};
// END GENERATED HASHES
const FILES = [
  './','./index.html','./styles.css','./app.js','./db.js','./data.js','./clibor.js','./manifest.webmanifest',
  './icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/apple-touch-icon.png',
  './icons/startup-1170x2532.png','./icons/startup-1179x2556.png','./icons/startup-750x1334.png'
];
const URLS = FILES.map(path=>new URL(path,self.registration.scope).href);
const ALLOWED = new Set(URLS);
async function cacheShell(){
  // Validate every release asset before committing any response. Repair only ever writes
  // the exact bytes belonging to this worker, even if the server now has a newer release.
  const responses=await Promise.all(FILES.map(async(path)=>{
    const response=await fetch(new URL(path,self.registration.scope),{cache:'reload',credentials:'omit'});
    if(!response.ok)throw new Error('Missing shell file');
    const bytes=await response.clone().arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(hash!==HASHES[path])throw new Error('Release integrity mismatch');
    return response;
  }));
  const cache=await caches.open(CACHE);
  await Promise.all(URLS.map((url,i)=>cache.put(url,responses[i])));
}
self.addEventListener('install',event=>{
  // A failed install never replaces the previous active worker or deletes its cache.
  event.waitUntil(cacheShell());
  // Do not skipWaiting: updates activate once every client using the old version closes.
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    await self.clients.claim();
    for(const key of await caches.keys())if(key.startsWith(PREFIX)&&key!==CACHE)await caches.delete(key);
  })());
});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  // The app has no network data APIs. Only the known static shell uses this cache.
  const clean=url.origin+url.pathname;
  if(!ALLOWED.has(clean))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE),cached=await cache.match(clean);
    if(cached)return cached;
    // Missing assets: return the online response, but do not mix release versions in cache.
    return fetch(request);
  })());
});
self.addEventListener('message',event=>{
  if(!['CACHE_STATUS','REPAIR_CACHE'].includes(event.data?.type)||!event.ports[0])return;
  event.waitUntil((async()=>{
    if(event.data.type==='REPAIR_CACHE'){
      try{await cacheShell();}catch{event.ports[0].postMessage({ready:false,version:VERSION});return;}
    }
    const cache=await caches.open(CACHE),entries=await Promise.all(URLS.map(url=>cache.match(url)));
    event.ports[0].postMessage({ready:entries.every(Boolean),version:VERSION});
  })());
});
