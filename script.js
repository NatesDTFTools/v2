(function(){
  const SHEET_DPI = 300;
  const SHEET_WIDTH_IN = 12.2;
  let GAP_IN = 0.5; // margin between designs (and left/right/bottom sheet margins), user-adjustable
  const TOP_MARGIN_IN = 0.1; // fixed small gap at the very top of the sheet only
  const RESIZE_MARGIN_IN = 0.1; // fixed small margin used when manually resizing a single design — lets a design be sized up to a true 12in wide (12.2 - 2*0.1) regardless of the adjustable "margin between designs" setting used for Auto Nest spacing
  let sheetBgColor = '#8a8d99'; // preview-only backdrop so white ink stays visible
  let PX_PER_IN = 60; // on-screen editing scale, adjustable via zoom

  const $ = (s)=>document.querySelector(s);
  const fileInput = $('#fileInput'), drop = $('#drop');
  const sheetCanvas = $('#sheetCanvas'), sheetWrap = $('#sheetWrap'), itemLayer = $('#itemLayer');
  const infoPanel = $('#infoPanel');
  const itemListEl = $('#itemList'), itemCountEl = $('#itemCount');
  const expandItemsBtn = $('#expandItemsBtn'), itemsModalOverlay = $('#itemsModalOverlay');
  const itemsModalList = $('#itemsModalList'), closeItemsModalBtn = $('#closeItemsModal');
  const contractSel = $('#contract');
  const hardEdgesCheckbox = $('#hardEdges');
  const autoNestBtn = $('#autoNestBtn'), centerBtn = $('#centerBtn'), clearBtn = $('#clearBtn'), exportBtn = $('#exportBtn');
  const autoFillBtn = $('#autoFillBtn'), fillLengthInput = $('#fillLengthInput');
  const marginInput = $('#marginInput'), bgColorInput = $('#bgColor');
  const bleedInput = $('#bleedInput'), exportCutlinesBtn = $('#exportCutlinesBtn');
  const preExportOverlay = $('#preExportOverlay'), removeTransparentBtn = $('#removeTransparentBtn');
  const alreadyCheckedBtn = $('#alreadyCheckedBtn'), cancelPreExportBtn = $('#cancelPreExport');
  const exportingOverlay = $('#exportingOverlay'), exportingTitle = $('#exportingTitle'), exportingSubtext = $('#exportingSubtext');
  const duplicatePopup = $('#duplicatePopup'), duplicatePopupHeader = $('#duplicatePopupHeader');
  const duplicatePopupBody = $('#duplicatePopupBody'), closeDuplicatePopupBtn = $('#closeDuplicatePopup');
  const popoutAutoNestBtn = $('#popoutAutoNestBtn'), autoNestPopup = $('#autoNestPopup');
  const autoNestPopupHeader = $('#autoNestPopupHeader'), closeAutoNestPopupBtn = $('#closeAutoNestPopup');
  const autoNestPopupBtn = $('#autoNestPopupBtn');
  const marqueeBox = $('#marqueeBox');
  const multiSelectPopup = $('#multiSelectPopup'), multiSelectPopupHeader = $('#multiSelectPopupHeader');
  const multiSelectCount = $('#multiSelectCount'), closeMultiSelectPopupBtn = $('#closeMultiSelectPopup');
  const multiSelectLockBtn = $('#multiSelectLockBtn'), multiSelectDeleteBtn = $('#multiSelectDeleteBtn');
  let bleedIn = 0.0625;
  const progressFill = $('#progressFill'), statusText = $('#statusText');
  const sheetHeightStat = $('#sheetHeightStat'), sheetPxStat = $('#sheetPxStat'), sheetWidthStat = $('#sheetWidthStat');
  const heightModeSel = $('#heightModeSel'), fixedHeightRow = $('#fixedHeightRow'), fixedHeightInput = $('#fixedHeightInput'), heightNote = $('#heightNote');
  const zoomInBtn = $('#zoomIn'), zoomOutBtn = $('#zoomOut'), zoomLabel = $('#zoomLabel');

  let items = []; // {id, name, file, img, nativeW, nativeH, xIn, yIn, wIn, hIn}
  let idSeq = 0;
  let selectedId = null;
  let multiSelected = new Set(); // ids of items selected via marquee drag
  let sheetHeightIn = 2;
  let heightMode = 'auto'; // 'auto' = grow to fit designs; 'fixed' = user-set height
  let fixedHeightIn = 60;
  let drag = null; // {mode:'move'|'resize', id, startMouseXIn, startMouseYIn, startX,startY,startW,startH}

  // ---------- undo history ----------
  // Each snapshot is a lightweight copy of every item's geometry/flags (the
  // heavy image data — file, img, w1Canvas — is shared by reference, not
  // cloned). pushHistory() is called BEFORE any change that should be
  // undoable; undo() restores the most recent snapshot.
  const HISTORY_LIMIT = 50;
  let history = [];
  let idSeqAtSnapshot = 0;
  function snapshotItems(){
    return items.map(it=>({
      id:it.id, name:it.name, file:it.file, img:it.img, nativeW:it.nativeW, nativeH:it.nativeH,
      mode:it.mode, w1Canvas:it.w1Canvas, xIn:it.xIn, yIn:it.yIn, wIn:it.wIn, hIn:it.hIn,
      rotated:it.rotated, rotationLocked:it.rotationLocked, locked:it.locked, cutLine:it.cutLine
    }));
  }
  function pushHistory(){
    history.push({ items: snapshotItems(), idSeq });
    if(history.length > HISTORY_LIMIT) history.shift();
  }
  function undo(){
    if(!history.length){ setStatus('Nothing to undo', false); return; }
    const prev = history.pop();
    items = prev.items;
    idSeq = prev.idSeq;
    selectedId = null;
    multiSelected.clear();
    if(typeof updateMultiSelectUI === 'function') updateMultiSelectUI();
    recomputeSheetHeight();
    render(); renderItemList(); hideInfo();
    exportBtn.disabled = items.length===0;
    if(typeof updateCutlineExportAvailability === 'function') updateCutlineExportAvailability();
    setStatus('Undo', true);
  }

  function setStatus(text, good){
    statusText.textContent = text;
    statusText.classList.toggle('good', !!good);
  }

  // ---------- file loading ----------
  browseAndDrop();
  function browseAndDrop(){
    drop.addEventListener('click', ()=>fileInput.click());
    fileInput.addEventListener('change', ()=>{ addFiles(fileInput.files); fileInput.value=''; });
    ['dragenter','dragover'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.add('drag');}));
    ['dragleave','drop'].forEach(ev=>drop.addEventListener(ev,(e)=>{e.preventDefault();drop.classList.remove('drag');}));
    drop.addEventListener('drop', (e)=>{ addFiles(e.dataTransfer.files); });
  }

  // Resizes an image/canvas the way a color-correct compositor should: any
  // "garbage" RGB hiding under fully (or mostly) transparent pixels — common
  // in real-world exported PNGs — must never bleed into visible edges during
  // a resize. Premultiplying by alpha before scaling and un-premultiplying
  // after guarantees this regardless of how any particular browser's
  // drawImage happens to be implemented internally.
  // ---------- sticker mode: cutline generation ----------
  function dilateBinary(mask, w, h, radius){
    if(radius<=0) return mask;
    const out = new Uint8Array(w*h);
    const r2 = radius*radius;
    const offsets = [];
    for(let dy=-radius; dy<=radius; dy++) for(let dx=-radius; dx<=radius; dx++){
      if(dx*dx+dy*dy <= r2) offsets.push([dx,dy]);
    }
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      if(!mask[y*w+x]) continue;
      for(const [dx,dy] of offsets){
        const nx=x+dx, ny=y+dy;
        if(nx>=0&&ny>=0&&nx<w&&ny<h) out[ny*w+nx]=1;
      }
    }
    return out;
  }

  // Moore-neighbor boundary tracing — walks the outer edge of a binary mask's
  // largest shape and returns an ordered list of boundary points.
  function traceOutline(mask, w, h){
    let startX=-1, startY=-1;
    outer:
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        if(mask[y*w+x]){ startX=x; startY=y; break outer; }
      }
    }
    if(startX<0) return [];
    const dirs = [[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1],[0,-1],[1,-1]];
    const isFg = (x,y)=> (x>=0&&y>=0&&x<w&&y<h) ? mask[y*w+x]!==0 : false;
    const boundary = [];
    let cx=startX, cy=startY, backtrackDir=6, count=0;
    const first = {x:cx,y:cy};
    do{
      boundary.push({x:cx,y:cy});
      let dir=(backtrackDir+1)%8, found=false;
      for(let i=0;i<8;i++){
        const d = dirs[(dir+i)%8];
        const nx=cx+d[0], ny=cy+d[1];
        if(isFg(nx,ny)){ backtrackDir=(dir+i+4)%8; cx=nx; cy=ny; found=true; break; }
      }
      if(!found) break;
      count++;
      if(count>w*h*4) break;
    } while(!(cx===first.x && cy===first.y) && count<100000);
    return boundary;
  }

  function perpendicularDistance(p, a, b){
    const dx=b.x-a.x, dy=b.y-a.y;
    const norm = Math.sqrt(dx*dx+dy*dy);
    if(norm===0) return Math.hypot(p.x-a.x,p.y-a.y);
    return Math.abs(dy*p.x - dx*p.y + b.x*a.y - b.y*a.x)/norm;
  }
  function douglasPeucker(points, epsilon){
    if(points.length<3) return points;
    let maxDist=0, index=0;
    const end = points.length-1;
    for(let i=1;i<end;i++){
      const d = perpendicularDistance(points[i], points[0], points[end]);
      if(d>maxDist){ maxDist=d; index=i; }
    }
    if(maxDist>epsilon){
      const left = douglasPeucker(points.slice(0,index+1), epsilon);
      const right = douglasPeucker(points.slice(index), epsilon);
      return left.slice(0,-1).concat(right);
    }
    return [points[0], points[end]];
  }

  function drawImageAlphaSafe(source, srcW, srcH, destCtx, dw, dh){
    // FAST PATH — design drawn at its exact native pixel size (not resized).
    // No interpolation happens, so we copy pixels through verbatim with no
    // premultiply round-trip and no smoothing. This guarantees an unresized
    // design is exported bit-for-bit identical to the imported file, including
    // anti-aliased edge pixels. The only export-time change to such a design
    // is the transparent-pixel cleanup done later, exactly as intended.
    if(srcW === dw && srcH === dh){
      const c = document.createElement('canvas');
      c.width = dw; c.height = dh;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = false;
      cx.drawImage(source, 0, 0, dw, dh);
      destCtx.imageSmoothingEnabled = false;
      destCtx.drawImage(c, 0, 0);
      return;
    }

    // SCALING PATH — design was resized, so interpolation is unavoidable.
    // Premultiply alpha before scaling and un-premultiply after, which is the
    // standard way to keep edges clean (prevents the dark/colored halos that
    // plain transparent-image scaling produces). Fully-opaque interior pixels
    // are unaffected by this; only genuinely scaled edge pixels are touched,
    // and this is the highest-quality option available.
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = srcW; srcCanvas.height = srcH;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(source, 0, 0, srcW, srcH);
    const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
    const sp = srcData.data;
    for(let i=0; i<sp.length; i+=4){
      const a = sp[i+3] / 255;
      sp[i]   = sp[i]   * a;
      sp[i+1] = sp[i+1] * a;
      sp[i+2] = sp[i+2] * a;
    }
    srcCtx.putImageData(srcData, 0, 0);

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = dw; scaledCanvas.height = dh;
    const scaledCtx = scaledCanvas.getContext('2d');
    scaledCtx.imageSmoothingEnabled = true;
    scaledCtx.imageSmoothingQuality = 'high';
    scaledCtx.drawImage(srcCanvas, 0, 0, dw, dh);
    const scaledData = scaledCtx.getImageData(0, 0, dw, dh);
    const dp = scaledData.data;
    for(let i=0; i<dp.length; i+=4){
      const a = dp[i+3] / 255;
      if(a > 0){
        dp[i]   = Math.min(255, dp[i]   / a);
        dp[i+1] = Math.min(255, dp[i+1] / a);
        dp[i+2] = Math.min(255, dp[i+2] / a);
      }
    }
    destCtx.putImageData(scaledData, 0, 0);
  }

  // Rotation-aware version used at export time: if the item is rotated 90°,
  // render it at its pre-rotation (native-aspect) pixel size first, then
  // rotate that raster into the destination context so it fills the swapped
  // (pxW x pxH) footprint correctly instead of just stretching the source.
  function drawItemForExport(it, destCtx, pxW, pxH){
    if(!it.rotated){
      drawImageAlphaSafe(it.img, it.nativeW, it.nativeH, destCtx, pxW, pxH);
      return;
    }
    const preW = pxH, preH = pxW; // pre-rotation pixel size matches native aspect
    const preCanvas = document.createElement('canvas');
    preCanvas.width = preW; preCanvas.height = preH;
    const preCtx = preCanvas.getContext('2d');
    drawImageAlphaSafe(it.img, it.nativeW, it.nativeH, preCtx, preW, preH);
    destCtx.save();
    destCtx.translate(pxW/2, pxH/2);
    destCtx.rotate(Math.PI/2);
    destCtx.drawImage(preCanvas, -preW/2, -preH/2, preW, preH);
    destCtx.restore();
  }

  async function loadImageElement(file){
    const ext = (file.name.split('.').pop()||'').toLowerCase();
    const inferredType = ext === 'svg' ? 'image/svg+xml' : 'image/png';
    const typedBlob = (file.type && file.type.startsWith('image/')) ? file : new Blob([file], {type: inferredType});
    const url = URL.createObjectURL(typedBlob);
    try{
      const img = new Image();
      await new Promise((res,rej)=>{
        img.onload = res;
        img.onerror = ()=>rej(new Error('Image failed to decode — the file may be corrupted, empty, or not a valid PNG/SVG.'));
        img.src = url;
      });
      return img;
    } finally {
      setTimeout(()=>URL.revokeObjectURL(url), 4000);
    }
  }

  // ---------- minimal TIFF reader, scoped to this tool's own export format ----------
  // (little-endian, uncompressed, single or multi-strip). Reads back whatever
  // channels are present — if a W1 channel (5th sample) is baked in from the
  // Step 1 tool, it's reused as-is rather than recomputed.
  function parseTIFF(arrayBuffer){
    const dv = new DataView(arrayBuffer);
    const b0 = dv.getUint8(0), b1 = dv.getUint8(1);
    let little;
    if(b0===0x49 && b1===0x49) little = true;
    else if(b0===0x4D && b1===0x4D) little = false;
    else throw new Error('Not a valid TIFF file (bad byte-order mark)');
    const magic = dv.getUint16(2, little);
    if(magic !== 42) throw new Error('Not a valid TIFF file (bad magic number)');
    const ifdOffset = dv.getUint32(4, little);

    const typeSizes = {1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8};
    const numEntries = dv.getUint16(ifdOffset, little);
    const tags = {};
    let p = ifdOffset + 2;
    for(let i=0;i<numEntries;i++){
      const tag = dv.getUint16(p, little);
      const type = dv.getUint16(p+2, little);
      const count = dv.getUint32(p+4, little);
      const tSize = typeSizes[type] || 1;
      const totalSize = tSize*count;
      const valueFieldOffset = p+8;
      const dataOffset = totalSize <= 4 ? valueFieldOffset : dv.getUint32(valueFieldOffset, little);
      const vals = [];
      for(let k=0;k<count;k++){
        let v;
        if(type===3) v = dv.getUint16(dataOffset+k*2, little);
        else if(type===4) v = dv.getUint32(dataOffset+k*4, little);
        else if(type===1) v = dv.getUint8(dataOffset+k);
        else if(type===5){ // RATIONAL: two uint32 (numerator/denominator)
          const num = dv.getUint32(dataOffset+k*8, little);
          const den = dv.getUint32(dataOffset+k*8+4, little);
          v = den ? num/den : 0;
        }
        else v = null;
        vals.push(v);
      }
      tags[tag] = vals;
      p += 12;
    }

    const width = tags[256][0];
    const height = tags[257][0];
    const samplesPerPixel = tags[277] ? tags[277][0] : 3;
    const compression = tags[259] ? tags[259][0] : 1;
    if(compression !== 1){
      throw new Error("This TIFF uses compression this importer doesn't support — please use an uncompressed TIFF (like the ones this tool exports).");
    }
    const stripOffsets = tags[273];
    const stripByteCounts = tags[279];
    if(!stripOffsets || !stripByteCounts){
      throw new Error('Unrecognized TIFF structure (no strip data found).');
    }

    const pixels = new Uint8Array(width*height*samplesPerPixel);
    let destOffset = 0;
    for(let s=0;s<stripOffsets.length;s++){
      const off = stripOffsets[s], len = stripByteCounts[s];
      const chunk = new Uint8Array(arrayBuffer, off, len);
      pixels.set(chunk, destOffset);
      destOffset += len;
    }

    // Real resolution: XResolution(282)/YResolution(283) are in units given by
    // ResolutionUnit(296): 2 = inches, 3 = centimetres. Convert cm to inches so
    // an imported TIFF reports its true physical size instead of assuming 300.
    let dpiX = null, dpiY = null;
    if(tags[282] && tags[282][0] > 0){
      const unit = tags[296] ? tags[296][0] : 2; // default inch
      const toInch = (unit === 3) ? 2.54 : 1; // per-cm -> per-inch
      dpiX = tags[282][0] * toInch;
      dpiY = (tags[283] && tags[283][0] > 0 ? tags[283][0] : tags[282][0]) * toInch;
    }
    return {width, height, samplesPerPixel, pixels, dpiX, dpiY};
  }

  function grayscaleCanvasFromBytes(width, height, bytes /* one value per pixel */){
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const cx = c.getContext('2d');
    const imgData = cx.createImageData(width, height);
    for(let i=0;i<width*height;i++){
      const v = bytes[i];
      const o = i*4;
      imgData.data[o]=v; imgData.data[o+1]=v; imgData.data[o+2]=v; imgData.data[o+3]=255;
    }
    cx.putImageData(imgData, 0, 0);
    return c;
  }

  // Loads any supported design file, returning a uniform descriptor:
  // { source: <Image|Canvas>, nativeW, nativeH, mode:'fresh'|'precomputed', w1Canvas }
  // 'fresh' designs get their choke computed at export time (PNG/SVG).
  // 'precomputed' designs already carry a baked W1 channel (TIFF from Step 1) —
  // that channel is reused as-is, never re-choked.
  // Reads an SVG's real declared size directly from its markup instead of
  // trusting the browser's naturalWidth/naturalHeight. Per spec, any SVG
  // that doesn't declare explicit width/height attributes gets a silent
  // fallback "natural size" of 300x150 from the browser — completely
  // unrelated to the actual artwork. This is extremely common for SVGs
  // exported by vector tools that only set a viewBox. Checked explicit
  // width/height first (most authoritative), then viewBox (still meaningful
  // — 1 user unit ≈ 1px by convention when no other unit is given), and only
  // returns null if the file genuinely has no size information at all.
  function parseSVGIntrinsicSize(svgText){
    const widthMatch = svgText.match(/<svg[^>]*\swidth=["']([\d.]+)(px)?["']/i);
    const heightMatch = svgText.match(/<svg[^>]*\sheight=["']([\d.]+)(px)?["']/i);
    if(widthMatch && heightMatch){
      return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) };
    }
    const viewBoxMatch = svgText.match(/<svg[^>]*\sviewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i);
    if(viewBoxMatch){
      return { width: parseFloat(viewBoxMatch[1]), height: parseFloat(viewBoxMatch[2]) };
    }
    return null;
  }

  // Reads the real DPI embedded in a PNG's pHYs chunk. PNG stores pixels-per-
  // METRE (not per inch) when the unit byte is 1, so we convert. Returns null
  // if the chunk is missing or uses "unknown" units, in which case the caller
  // falls back to the sheet's default DPI. This is what lets an image saved at,
  // say, 288 DPI in Photoshop import at its true physical size instead of
  // being mis-measured as if it were 300 DPI.
  async function readPngDpi(file){
    try{
      const buf = new Uint8Array(await file.arrayBuffer());
      // PNG signature is 8 bytes; chunks follow as [len(4)][type(4)][data][crc(4)]
      if(buf.length < 8 || buf[0]!==0x89 || buf[1]!==0x50) return null;
      let p = 8;
      const dv = new DataView(buf.buffer);
      while(p + 8 <= buf.length){
        const len = dv.getUint32(p);
        const type = String.fromCharCode(buf[p+4],buf[p+5],buf[p+6],buf[p+7]);
        if(type === 'pHYs'){
          const ppuX = dv.getUint32(p+8);
          const ppuY = dv.getUint32(p+12);
          const unit = buf[p+16]; // 1 = metre, 0 = unknown/aspect-only
          if(unit === 1 && ppuX > 0){
            const dpiX = ppuX * 0.0254; // pixels/metre -> pixels/inch
            const dpiY = ppuY > 0 ? ppuY * 0.0254 : dpiX;
            return { dpiX, dpiY };
          }
          return null; // unit=0 means the values are only an aspect ratio, no real DPI
        }
        if(type === 'IDAT' || type === 'IEND') break; // pHYs always precedes image data
        p += 12 + len; // advance past this chunk
      }
    }catch(err){ /* fall through to default DPI */ }
    return null;
  }

  async function loadDesign(file){
    const ext = (file.name.split('.').pop()||'').toLowerCase();
    if(ext==='tif' || ext==='tiff'){
      const buf = await file.arrayBuffer();
      const parsed = parseTIFF(buf);
      const {width, height, samplesPerPixel, pixels} = parsed;
      const rgbaCanvas = document.createElement('canvas');
      rgbaCanvas.width = width; rgbaCanvas.height = height;
      const rctx = rgbaCanvas.getContext('2d');
      const imgData = rctx.createImageData(width, height);
      const n = width*height;
      for(let i=0;i<n;i++){
        const si = i*samplesPerPixel, di = i*4;
        imgData.data[di]   = pixels[si];
        imgData.data[di+1] = pixels[si+1];
        imgData.data[di+2] = pixels[si+2];
        imgData.data[di+3] = samplesPerPixel>=4 ? pixels[si+3] : 255;
      }
      rctx.putImageData(imgData, 0, 0);

      let w1Canvas = null;
      if(samplesPerPixel>=5){
        const w1Bytes = new Uint8Array(n);
        for(let i=0;i<n;i++) w1Bytes[i] = pixels[i*samplesPerPixel+4];
        w1Canvas = grayscaleCanvasFromBytes(width, height, w1Bytes);
      }
      return {source: rgbaCanvas, nativeW: width, nativeH: height, mode: w1Canvas ? 'precomputed' : 'fresh', w1Canvas, dpiX: parsed.dpiX, dpiY: parsed.dpiY};
    } else {
      const img = await loadImageElement(file);
      let nativeW = img.naturalWidth || img.width || 900;
      let nativeH = img.naturalHeight || img.height || 900;
      let dpiX = null, dpiY = null;
      if(ext === 'png'){
        const d = await readPngDpi(file);
        if(d){ dpiX = d.dpiX; dpiY = d.dpiY; }
      }
      if(ext === 'svg'){
        try{
          const svgText = await file.text();
          const realSize = parseSVGIntrinsicSize(svgText);
          if(realSize && realSize.width > 0 && realSize.height > 0){
            nativeW = realSize.width;
            nativeH = realSize.height;
          }
        }catch(err){ /* fall back to whatever the Image element reported */ }
      }
      return {source: img, nativeW, nativeH, mode: 'fresh', w1Canvas: null, dpiX, dpiY};
    }
  }

  async function addFiles(fileList){
    const accepted = [...fileList].filter(f=>/\.(png|svg|tif|tiff)$/i.test(f.name));
    if(!accepted.length) return;
    pushHistory();
    setStatus('Loading designs…');
    for(const f of accepted){
      try{
        const d = await loadDesign(f);
        // Use the file's REAL embedded DPI so a design imports at its true
        // physical size. Only fall back to the sheet default (300) when the
        // file carries no resolution info at all. A 288-DPI Photoshop file,
        // for example, now comes in at its actual inches instead of being
        // measured as if it were 300 DPI (which shrank it).
        const dpiX = (d.dpiX && d.dpiX > 1) ? d.dpiX : SHEET_DPI;
        const dpiY = (d.dpiY && d.dpiY > 1) ? d.dpiY : dpiX;
        let wIn = d.nativeW / dpiX;
        let hIn = d.nativeH / dpiY;
        // if a design is wider than the sheet's usable width (accounting for
        // the side margins it'll need once nested), scale it down to fit —
        // otherwise a "full bleed" 12in-wide design would still be wider
        // than the packable area even before Auto Nest ever runs
        const maxW = SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN;
        if(wIn > maxW){ const s = maxW/wIn; wIn *= s; hIn *= s; }
        items.push({
          id:++idSeq, name:f.name, file:f, img:d.source,
          nativeW:d.nativeW, nativeH:d.nativeH,
          mode:d.mode, w1Canvas:d.w1Canvas,
          xIn:GAP_IN, yIn:TOP_MARGIN_IN, wIn, hIn, rotated:false, rotationLocked:false, locked:false
        });
      }catch(err){
        console.error('Failed to load', f.name, err);
        setStatus('Failed to load '+f.name+': '+err.message);
      }
    }
    autoNest();
    render();
    renderItemList();
    setStatus(items.length ? items.length+' design(s) on sheet' : 'Waiting for designs', true);
    exportBtn.disabled = items.length===0;
  }

  // ---------- auto nest (MaxRects 2D bin packing) ----------
  // Shelf packing (the old approach) lines items up into horizontal rows sized
  // to the tallest item in each row — any row with a mix of tall and short
  // designs wastes the leftover height next to the short ones, since nothing
  // else is ever placed there. MaxRects fixes this: it tracks the actual set
  // of free rectangles left on the sheet as items are placed, and lets a
  // later (smaller) item drop into any leftover gap — beside OR below an
  // earlier item — not just the current row. This is the same class of
  // algorithm cutting/nesting software uses, and produces a visibly shorter
  // sheet whenever design sizes are mixed.
  //
  // Rotation: for every item (unless its rotation is locked), both the
  // current orientation and a 90°-rotated one are tried against every free
  // rectangle. Whichever (rectangle, orientation) combination is tightest —
  // and, first and foremost, keeps the item as high up the sheet as
  // possible — wins. That's what lets a tall narrow design automatically
  // flip on its side when doing so saves sheet height.
  //
  // Sorting is done by each item's SHORTEST side, not its current hIn — sorting
  // by hIn directly caused a real bug: since packing can rotate an item
  // (swapping wIn/hIn), the next Auto Nest click would see a different hIn and
  // re-sort into a different order, producing a different (if equally valid)
  // layout every time. Shortest-side is invariant regardless of current
  // rotation state, so results stay stable across repeated clicks.
  //
  // As before, several sort orders are tried on disposable clones and
  // whichever actually produces the shortest sheet is applied for real.

  function rectsIntersect(a,b){
    return a.x < b.x+b.w-1e-9 && a.x+a.w > b.x+1e-9 && a.y < b.y+b.h-1e-9 && a.y+a.h > b.y+1e-9;
  }
  function rectContains(outer, inner){
    return inner.x>=outer.x-1e-9 && inner.y>=outer.y-1e-9 &&
           inner.x+inner.w<=outer.x+outer.w+1e-9 && inner.y+inner.h<=outer.y+outer.h+1e-9;
  }
  // Splits every free rect that overlaps `placed` into the leftover slivers
  // around it (up to 4 per overlapping rect), then drops any free rect that's
  // fully contained inside another (keeps the free-list from growing stale/redundant).
  function splitFreeRects(freeRects, placed){
    const out = [];
    for(const r of freeRects){
      if(!rectsIntersect(r, placed)){ out.push(r); continue; }
      if(placed.x > r.x) out.push({x:r.x, y:r.y, w:placed.x-r.x, h:r.h});
      if(placed.x+placed.w < r.x+r.w) out.push({x:placed.x+placed.w, y:r.y, w:(r.x+r.w)-(placed.x+placed.w), h:r.h});
      if(placed.y > r.y) out.push({x:r.x, y:r.y, w:r.w, h:placed.y-r.y});
      if(placed.y+placed.h < r.y+r.h) out.push({x:r.x, y:placed.y+placed.h, w:r.w, h:(r.y+r.h)-(placed.y+placed.h)});
    }
    const pruned = [];
    for(let i=0;i<out.length;i++){
      if(out[i].w<=1e-9 || out[i].h<=1e-9) continue;
      let contained = false;
      for(let j=0;j<out.length;j++){
        if(i===j) continue;
        if(rectContains(out[j], out[i])){ contained = true; break; }
      }
      if(!contained) pruned.push(out[i]);
    }
    return pruned;
  }

  // Runs the MaxRects packing core on a given array of item-like objects, using
  // whatever comparator decides processing order. Returns the resulting total
  // height needed. Operates on plain objects with wIn/hIn/rotated/rotationLocked/
  // xIn/yIn so it can be run on throwaway clones to test a strategy before
  // committing to it.
  function packCore(arr, comparator, obstacles){
    obstacles = obstacles || [];
    const usableW = SHEET_WIDTH_IN - GAP_IN;
    const maxAllowedW = SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN; // widest a design can be and still keep both side margins
    const sorted = [...arr].sort(comparator);
    const everything = arr.concat(obstacles);
    const BIN_H = everything.reduce((s,it)=> s + Math.max(it.wIn,it.hIn), 0) + GAP_IN*(everything.length+2); // generous, trimmed to actual use afterward
    let freeRects = [{x:0, y:0, w:usableW, h:BIN_H}];
    // Locked items never move — carve their current footprint out of the
    // free space up front, same as if something had already been placed
    // there, so nothing else gets nested on top of them.
    for(const ob of obstacles){
      freeRects = splitFreeRects(freeRects, {x: ob.xIn-GAP_IN, y: ob.yIn-TOP_MARGIN_IN, w: ob.wIn+GAP_IN, h: ob.hIn+GAP_IN});
    }
    let placedBottom = obstacles.length ? Math.max(...obstacles.map(o=>o.yIn+o.hIn)) : 0; // running max(y+h) across items already placed THIS pass, in real sheet inches

    for(const it of sorted){
      const orientations = [{w:it.wIn, h:it.hIn, rotated:!!it.rotated}];
      if(!it.rotationLocked && Math.abs(it.wIn-it.hIn) > 1e-9){
        orientations.push({w:it.hIn, h:it.wIn, rotated:!it.rotated});
      }

      let best = null;
      for(const orient of orientations){
        // footprint bakes the trailing margin into the size being packed, so
        // placed items always end up with a gap before whatever comes next
        const fw = orient.w + GAP_IN, fh = orient.h + GAP_IN;
        for(const rect of freeRects){
          if(fw <= rect.w+1e-9 && fh <= rect.h+1e-9){
            // PRIMARY objective: the item's resulting BOTTOM edge (how far
            // down the sheet it reaches). Minimizing this across every
            // candidate placement AND orientation is what actually keeps the
            // finished sheet short — and it's what makes a lone tall-narrow
            // design rotate flat, since lying flat reaches far less far down
            // than standing tall. SECONDARY (tie-break): best-area-fit, i.e.
            // prefer the snuggest gap, so once bottom-edge is equal we still
            // avoid carving usable space into unusable slivers.
            const bottom = rect.y + fh;
            const leftoverArea = rect.w*rect.h - fw*fh;
            const shortSideFit = Math.min(rect.w-fw, rect.h-fh);
            if(!best ||
               bottom < best.bottom - 1e-9 ||
               (Math.abs(bottom-best.bottom)<1e-9 && leftoverArea < best.leftoverArea-1e-9) ||
               (Math.abs(bottom-best.bottom)<1e-9 && Math.abs(leftoverArea-best.leftoverArea)<1e-9 && shortSideFit < best.shortSideFit-1e-9) ||
               (Math.abs(bottom-best.bottom)<1e-9 && Math.abs(leftoverArea-best.leftoverArea)<1e-9 && Math.abs(shortSideFit-best.shortSideFit)<1e-9 && rect.x < best.rect.x-1e-9)){
              best = {rect, orient, fw, fh, shortSideFit, leftoverArea, bottom};
            }
          }
        }
      }

      if(best){
        it.wIn = best.orient.w; it.hIn = best.orient.h; it.rotated = best.orient.rotated;
        it.xIn = best.rect.x + GAP_IN; it.yIn = best.rect.y + TOP_MARGIN_IN;
        freeRects = splitFreeRects(freeRects, {x:best.rect.x, y:best.rect.y, w:best.fw, h:best.fh});
      } else {
        // Only reached when a design is wider than the packable area even
        // after rotation — most commonly a "full sheet" design sized to the
        // full 12in width, which is still wider than the ~11in actually left
        // once both side margins are subtracted. Rather than distorting it
        // (clamping width alone would squash its aspect ratio) or guessing
        // its Y position from other items' stale pre-pack coordinates, scale
        // it down proportionally to fit and stack it directly below
        // whatever has actually been placed so far this pass.
        const orient = orientations.reduce((a,b)=> (b.w < a.w ? b : a)); // narrower orientation needs the least shrinking
        let w = orient.w, h = orient.h;
        if(w > maxAllowedW){
          const scale = maxAllowedW / w;
          w *= scale; h *= scale;
        }
        it.wIn = w; it.hIn = h; it.rotated = orient.rotated;
        it.xIn = RESIZE_MARGIN_IN;
        it.yIn = placedBottom + (placedBottom>0 ? GAP_IN : TOP_MARGIN_IN);
        freeRects = splitFreeRects(freeRects, {x:0, y:it.yIn-TOP_MARGIN_IN, w:w+GAP_IN, h:h+GAP_IN});
      }
      placedBottom = Math.max(placedBottom, it.yIn + it.hIn);
    }
    const bottoms = arr.map(it=>it.yIn+it.hIn).concat(obstacles.map(o=>o.yIn+o.hIn));
    return Math.max(GAP_IN, ...bottoms) + GAP_IN;
  }

  // Locked designs (see the Lock button on the design popup) are never
  // touched by Auto Nest — they keep whatever position, size, and rotation
  // they currently have. Only the unlocked designs get packed, and they're
  // packed AROUND the locked ones (locked footprints are carved out of the
  // free space first) so nothing new gets nested on top of a locked design.
  function packItems(){
    const lockedItems = items.filter(it=>it.locked);
    const unlockedItems = items.filter(it=>!it.locked);
    if(!unlockedItems.length){ recomputeSheetHeight(); return; }

    // Group identical unlocked designs (same name + size, regardless of
    // current rotation) so repeated copies nest as ONE consistently-oriented
    // grid instead of a scattered mix of rotated/unrotated instances. This is
    // what actually matters for production: rows of the same design, all in
    // the same orientation, are what make post-print cutting fast — a few
    // extra inches of sheet height is a good trade for that. A design that's
    // been manually rotation-locked (via the popup's Rotate button) is left
    // exactly as-is and packed individually, never regrouped.
    // A row of designs needs BOTH side margins subtracted from the sheet
    // width, not just one (that's the bug that was letting grouped columns
    // run past the right margin).
    const maxRowW = SHEET_WIDTH_IN - 2*GAP_IN;
    const byKey = new Map();
    const singles = [];
    for(const it of unlockedItems){
      if(it.rotationLocked){ singles.push(it); continue; }
      const longSide = Math.max(it.wIn, it.hIn), shortSide = Math.min(it.wIn, it.hIn);
      const key = it.name + '@' + longSide.toFixed(2) + 'x' + shortSide.toFixed(2);
      if(!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(it);
    }
    const planned = [];
    for(const groupItems of byKey.values()){
      if(groupItems.length < 2){ singles.push(...groupItems); continue; }
      const w0 = groupItems[0].wIn, h0 = groupItems[0].hIn;
      const longSide = Math.max(w0,h0), shortSide = Math.min(w0,h0);
      const n = groupItems.length;
      // For a candidate orientation (w = the side used as width), work out
      // how many fit per row on this sheet and how many rows that needs.
      // Comparing landscape vs. portrait THIS WAY — by total rows needed —
      // is exactly "rotate it if that lets more copies line up per row",
      // decided once for the whole design instead of per copy.
      const groupMaxW = SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN; // widest a single copy can be and still keep both edge margins
      function planFor(w,h){
        // If this orientation would be wider than the sheet, DON'T shrink the
        // artwork to force it — that would silently resize the user's design.
        // Instead flag it invalid so it simply isn't chosen; the other
        // orientation (or the oversized-fallback below) handles it. Auto Nest
        // may rotate freely, but it must never change a design's real size.
        if(w > groupMaxW + 1e-9){ return { w, h, cols:1, rows:n, blockH: Infinity, invalid:true }; }
        const cols = Math.max(1, Math.min(n, Math.floor((maxRowW + GAP_IN) / (w + GAP_IN))));
        const rows = Math.ceil(n / cols);
        const blockH = rows*h + (rows-1)*GAP_IN; // total vertical space this whole grid occupies
        return { w, h, cols, rows, blockH };
      }
      const optA = planFor(longSide, shortSide); // long side horizontal
      const optB = (Math.abs(longSide-shortSide) > 1e-9) ? planFor(shortSide, longSide) : null; // long side vertical
      let chosen;
      if(optA.invalid && optB && !optB.invalid){
        chosen = optB;
      } else if(optB && optB.invalid){
        chosen = optA;
      } else {
        chosen = optA;
        // Choose whichever orientation makes the design's whole grid SHORTER.
        // Comparing total block height (not row count) is what actually saves
        // sheet height: a landscape design might need more rows but each row
        // is much shorter, so it can still win over a taller portrait layout.
        if(optB && optB.blockH < chosen.blockH - 1e-9){ chosen = optB; }
      }
      // Both orientations too wide for the sheet — a genuinely oversized
      // design. Fall back to shrinking the least-wide orientation to fit
      // (this is the only case where resizing is unavoidable).
      if(chosen.invalid){
        let w = shortSide, h = longSide;
        const s = groupMaxW / w; w *= s; h *= s;
        const cols = Math.max(1, Math.min(n, Math.floor((maxRowW + GAP_IN) / (w + GAP_IN))));
        const rows = Math.ceil(n / cols);
        chosen = { w, h, cols, rows, blockH: rows*h+(rows-1)*GAP_IN };
      }
      const blockIsLandscape = Math.abs(chosen.w - longSide) < 1e-9;
      // IMPORTANT: each ROW becomes its own independently-placeable block —
      // NOT one giant block for the whole design. Gluing every copy into a
      // single rigid rectangle meant the packer could only place it where
      // the ENTIRE grid fit, so a locked design leaving an awkwardly-shaped
      // gap (tall enough for some rows but not all of them) would force the
      // whole grid below it, wasting all that leftover space. Splitting per
      // row lets the packer tuck a few rows into any gap that fits them,
      // while every row of a given design still shares the same size and
      // orientation — which is what actually matters for cutting.
      for(let start=0; start<n; start+=chosen.cols){
        planned.push({ items: groupItems.slice(start, start+chosen.cols), w: chosen.w, h: chosen.h, blockIsLandscape });
      }
    }

    // Every row-of-a-design becomes one rectangular block for placement
    // purposes; every leftover one-off design is its own free-to-rotate
    // block of one.
    const packables = [
      ...planned.map((p,pi)=>({ packId:'r'+pi, pi, wIn: p.items.length*p.w+(p.items.length-1)*GAP_IN, hIn:p.h, rotated:false, rotationLocked:true, xIn:0, yIn:0 })),
      // Single/one-off designs pack individually AND are allowed to rotate
      // (unless the user manually rotation-locked them). A row-block above is
      // rotationLocked because its whole point is a fixed shared orientation
      // for clean cutting — but a lone design has no such constraint, so it
      // should flip 90° whenever that saves sheet height. Leaving these
      // rotationLocked was the bug where a tall-narrow design wouldn't nest
      // sideways until you rotated it by hand first.
      ...singles.map(it=>({ packId:'s'+it.id, it, wIn:it.wIn, hIn:it.hIn, rotated:it.rotated, rotationLocked:it.rotationLocked, xIn:0, yIn:0 }))
    ];

    const strategies = [
      (a,b)=> Math.min(b.wIn,b.hIn) - Math.min(a.wIn,a.hIn), // shortest side first
      (a,b)=> Math.max(b.wIn,b.hIn) - Math.max(a.wIn,a.hIn), // longest side first
      (a,b)=> (b.wIn*b.hIn) - (a.wIn*a.hIn),                 // largest area first
      (a,b)=> b.hIn - a.hIn,                                 // tallest (current orientation) first
      (a,b)=> b.wIn - a.wIn,                                 // widest (current orientation) first
    ];

    let bestClone = null, bestHeight = Infinity;
    // Two orientation presets for the free-to-rotate single designs:
    //  - 'asis'  : leave each single's current orientation, let packCore decide
    //  - 'flat'  : start each free single in its shortest-height (widest)
    //              orientation, which is what a lone or loosely-packed design
    //              wants so it lies flat instead of standing tall
    // Every sort strategy is run under BOTH presets and the shortest overall
    // sheet wins, so we never lock in a worse layout — we just make sure the
    // flat option is actually considered. This fixes the "won't auto-rotate
    // until I rotate it by hand" bug.
    const orientPresets = ['asis','flat'];
    for(const preset of orientPresets){
      for(const cmp of strategies){
        const clone = packables.map(p => {
          let w = p.wIn, h = p.hIn, rot = p.rotated;
          if(preset==='flat' && p.it && !p.rotationLocked && h > w){
            w = p.hIn; h = p.wIn; rot = !p.rotated; // pre-flatten free singles
          }
          return { id: p.packId, wIn: w, hIn: h, rotated: rot,
                   rotationLocked: p.rotationLocked, xIn: p.xIn, yIn: p.yIn };
        });
        const height = packCore(clone, cmp, lockedItems);
        if(height < bestHeight - 1e-9){ bestHeight = height; bestClone = clone; }
      }
    }

    for(const p of packables){
      const match = bestClone.find(c => c.id === p.packId);
      if(p.it){
        // singleton design — same as before, packed on its own
        const it = p.it;
        it.xIn = match.xIn; it.yIn = match.yIn;
        it.wIn = match.wIn; it.hIn = match.hIn; it.rotated = match.rotated;
      } else {
        // one row of a design — lay its items left-to-right along the block
        const plan = planned[p.pi];
        const nativeLandscape0 = plan.items[0].nativeW >= plan.items[0].nativeH;
        plan.items.forEach((it, idx)=>{
          it.xIn = match.xIn + idx*(plan.w+GAP_IN);
          it.yIn = match.yIn;
          it.wIn = plan.w; it.hIn = plan.h;
          const nativeLandscape = it.nativeW >= it.nativeH;
          it.rotated = (plan.blockIsLandscape !== nativeLandscape);
        });
      }
    }

    compactUpward(lockedItems);
    relocateRowsToGaps(lockedItems);
    compactUpward(lockedItems);
    recomputeSheetHeight();
  }

  // Relocate whole rows into side gaps — but only when it makes the sheet
  // SHORTER. After the main pack, the lowest rows are what set total height;
  // meanwhile there's often empty space beside a taller design higher up (the
  // classic "tall design leaves a wasted strip down its right side"). This
  // pass takes each row sitting at the bottom and tries to move it, as a
  // cohesive unit, into that free space — trying both the row's current
  // orientation and a rotated one. A move is only committed if it strictly
  // lowers the sheet's overall height AND causes no overlap, so this can
  // never make a layout worse (that was the flaw in the earlier gap-filler).
  function relocateRowsToGaps(lockedItems){
    const obstacles = (lockedItems||[]).slice();
    const EPS = 1e-6;

    // group unlocked items into rows by shared (yIn, hIn, name) — these are the
    // clean rows produced by the packer; moving them as a unit keeps groups tidy
    function currentRows(){
      const movers = items.filter(it=>!it.locked && !it.rotationLocked);
      const rows = [];
      for(const it of movers){
        let row = rows.find(r => Math.abs(r.yIn-it.yIn)<0.01 && Math.abs(r.hIn-it.hIn)<0.01 && r.name===it.name);
        if(!row){ row = {yIn:it.yIn, hIn:it.hIn, name:it.name, items:[]}; rows.push(row); }
        row.items.push(it);
      }
      return rows;
    }

    function collidesRect(x,y,w,h,ignoreSet){
      if(x < RESIZE_MARGIN_IN-EPS || x+w > SHEET_WIDTH_IN-RESIZE_MARGIN_IN+EPS || y < TOP_MARGIN_IN-EPS) return true;
      for(const o of items){
        if(o.locked || ignoreSet.has(o)) continue;
        if(x < o.xIn+o.wIn+GAP_IN-EPS && x+w+GAP_IN > o.xIn+EPS && y < o.yIn+o.hIn+GAP_IN-EPS && y+h+GAP_IN > o.yIn+EPS) return true;
      }
      for(const o of obstacles){
        if(x < o.xIn+o.wIn+GAP_IN-EPS && x+w+GAP_IN > o.xIn+EPS && y < o.yIn+o.hIn+GAP_IN-EPS && y+h+GAP_IN > o.yIn+EPS) return true;
      }
      return false;
    }

    let improved = true, guard = 0;
    while(improved && guard++ < 30){
      improved = false;
      const sheetBottom = Math.max(0, ...items.map(it=>it.yIn+it.hIn));
      const rows = currentRows().sort((a,b)=> (b.yIn+b.hIn) - (a.yIn+a.hIn)); // lowest rows first

      for(const row of rows){
        // only consider rows that actually touch the bottom band (they're what
        // drive height; moving a row that isn't at the bottom won't shrink it)
        if(row.yIn + row.hIn < sheetBottom - EPS) continue;

        const n = row.items.length;
        const cw = row.items[0].wIn, ch = row.items[0].hIn; // each cell's size
        const ignoreSet = new Set(row.items);

        // candidate cell orientations: as-is, and rotated 90°
        const cellOrients = [{w:cw, h:ch, rot:row.items[0].rotated}];
        if(Math.abs(cw-ch) > 1e-9) cellOrients.push({w:ch, h:cw, rot:!row.items[0].rotated});

        let bestMove = null; // {x,y,cellW,cellH,rot, perRow, newBottom}
        // candidate x anchors: left margin + right edge of every other design
        const anchorXs = new Set([RESIZE_MARGIN_IN]);
        for(const o of items){ if(!ignoreSet.has(o) && !o.locked) anchorXs.add(o.xIn+o.wIn+GAP_IN); }
        for(const o of obstacles) anchorXs.add(o.xIn+o.wIn+GAP_IN);

        for(const oc of cellOrients){
          for(const ax of anchorXs){
            // how many cells fit across starting at ax within the sheet width?
            const availW = (SHEET_WIDTH_IN-RESIZE_MARGIN_IN) - ax;
            const perRow = Math.max(1, Math.min(n, Math.floor((availW+GAP_IN)/(oc.w+GAP_IN))));
            const rowsNeeded = Math.ceil(n/perRow);
            // candidate y anchors: top margin + bottom edge of anything in this x-span
            const spanW = perRow*oc.w + (perRow-1)*GAP_IN;
            const anchorYs = new Set([TOP_MARGIN_IN]);
            for(const o of items){
              if(ignoreSet.has(o) || o.locked) continue;
              if(ax < o.xIn+o.wIn+GAP_IN-EPS && ax+spanW+GAP_IN > o.xIn+EPS) anchorYs.add(o.yIn+o.hIn+GAP_IN);
            }
            for(const o of obstacles){
              if(ax < o.xIn+o.wIn+GAP_IN-EPS && ax+spanW+GAP_IN > o.xIn+EPS) anchorYs.add(o.yIn+o.hIn+GAP_IN);
            }
            for(const ay of [...anchorYs].sort((a,b)=>a-b)){
              // try laying the whole group as a grid at (ax,ay); check every cell
              let ok = true;
              const placements = [];
              for(let k=0;k<n && ok;k++){
                const r = Math.floor(k/perRow), c = k%perRow;
                const px = ax + c*(oc.w+GAP_IN), py = ay + r*(oc.h+GAP_IN);
                if(collidesRect(px,py,oc.w,oc.h,ignoreSet)){ ok=false; break; }
                placements.push({px,py});
              }
              if(!ok) continue;
              const groupBottom = ay + rowsNeeded*oc.h + (rowsNeeded-1)*GAP_IN;
              // recompute what the sheet bottom WOULD be after this move
              let otherBottom = 0;
              for(const o of items){ if(ignoreSet.has(o)||o.locked) continue; otherBottom = Math.max(otherBottom, o.yIn+o.hIn); }
              for(const o of obstacles) otherBottom = Math.max(otherBottom, o.yIn+o.hIn);
              const newBottom = Math.max(otherBottom, groupBottom);
              if(newBottom < sheetBottom - EPS){
                if(!bestMove || newBottom < bestMove.newBottom - EPS){
                  bestMove = {placements, cellW:oc.w, cellH:oc.h, rot:oc.rot, newBottom};
                }
              }
              break; // first (highest) valid ay for this ax/orient is enough
            }
          }
        }

        if(bestMove){
          row.items.forEach((it, k)=>{
            it.xIn = bestMove.placements[k].px;
            it.yIn = bestMove.placements[k].py;
            it.wIn = bestMove.cellW; it.hIn = bestMove.cellH; it.rotated = bestMove.rot;
          });
          improved = true;
          break; // re-evaluate from scratch after any successful move
        }
      }
    }
  }

  // Gravity compaction: after the main placement, slide every unlocked design
  // straight up as far as it can go without overlapping anything above it (or
  // a locked design, or the top margin). Running this repeatedly lets designs
  // settle into the gaps left beside taller neighbors — which is exactly how
  // the dense reference sheets fill different designs into the same horizontal
  // bands and eliminate wasted vertical space. Items only ever move vertically
  // here, so a group's clean left-to-right row alignment is preserved; whole
  // rows just drop into whatever space opens up, and can end up beside a
  // different design rather than stacked below it.
  function compactUpward(lockedItems){
    const movers = items.filter(it=>!it.locked);
    const obstacles = (lockedItems||[]).slice();
    // process top-to-bottom so higher items settle first and become supports
    movers.sort((a,b)=> a.yIn - b.yIn || a.xIn - b.xIn);
    let changed = true, guard = 0;
    while(changed && guard++ < 200){
      changed = false;
      for(const it of movers){
        // the highest y this item could rise to: just below whatever solid
        // thing (another mover placed above, or a locked obstacle) sits in its
        // horizontal span, or the top margin if nothing blocks it
        let limit = TOP_MARGIN_IN;
        const others = movers.filter(o=>o!==it).concat(obstacles);
        for(const o of others){
          const overlapX = it.xIn < o.xIn+o.wIn + GAP_IN - 1e-9 && it.xIn+it.wIn + GAP_IN > o.xIn + 1e-9;
          if(!overlapX) continue;
          if(o.yIn + o.hIn <= it.yIn + 1e-9){
            limit = Math.max(limit, o.yIn + o.hIn + GAP_IN);
          }
        }
        if(limit < it.yIn - 1e-9){ it.yIn = limit; changed = true; }
      }
    }
  }
  // NOTE: a previous version re-centered the whole packed block horizontally
  // after nesting. That was purely cosmetic (a uniform sideways shift can't
  // change total height), but it added equal left/right margins that made
  // the layout look padded rather than tight to the edges. Auto Nest now
  // leaves every item exactly where packItems() placed it — hugging the
  // sheet's edges as closely as the margin setting allows, which is what
  // actually keeps sheet height to a minimum. Use "Center All Designs" if
  // you want a centered look afterward.
  function autoNest(){ packItems(); }

  // Center existing rows horizontally without re-sorting or re-grouping anything —
  // groups items by their current vertical overlap (whatever row they're already
  // in, from Auto Nest or manual dragging), keeps left-to-right order within each
  // row, and just shifts each row to be centered in the 12in width.
  // Groups by shared top position (not overlapping range) — an item's top-left
  // never moves when you resize it, only its width/height do, so this stays
  // correct even after designs have been resized. A small tolerance absorbs
  // any tiny floating-point drift.
  const ROW_TOLERANCE_IN = 0.05;
  function centerAllDesigns(){
    if(!items.length) return;

    // Center the whole layout horizontally WITHOUT disturbing the vertical
    // packing Auto Nest computed. Earlier this function re-detected rows by
    // y-position and re-stacked them from scratch — but MaxRects legitimately
    // places designs of different heights at different y-values, so that row
    // detection split one visual band into many single-item "rows" and then
    // spread them out with a full gap each, exploding the sheet vertically and
    // wasting film. Instead we now treat the placed designs as one rigid block
    // and slide that block sideways so it's centered on the sheet width. A
    // uniform horizontal shift can never introduce an overlap or change height.
    const movers = items.filter(it=>!it.locked);
    if(!movers.length) return;

    const minX = Math.min(...movers.map(it=>it.xIn));
    const maxX = Math.max(...movers.map(it=>it.xIn + it.wIn));
    const blockW = maxX - minX;
    const targetLeft = Math.max(RESIZE_MARGIN_IN, (SHEET_WIDTH_IN - blockW) / 2);
    const shift = targetLeft - minX;

    if(Math.abs(shift) > 1e-9){
      for(const it of movers){
        // don't let the shift push anything off either edge
        it.xIn = Math.min(
          Math.max(RESIZE_MARGIN_IN, it.xIn + shift),
          SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn
        );
      }
    }
    recomputeSheetHeight();
  }
  function recomputeSheetHeight(){
    const contentH = items.length ? (Math.max(2, ...items.map(it=>it.yIn+it.hIn)) + GAP_IN) : 2;
    if(heightMode === 'fixed'){
      // Sheet is the fixed height the user chose — unless the designs actually
      // need more room, in which case we never shrink below them (that would
      // silently crop artwork). The export overhang check already warns if
      // something spills past the bottom.
      sheetHeightIn = Math.max(fixedHeightIn, contentH);
    } else {
      sheetHeightIn = contentH;
    }
  }

  function runAutoNest(){ pushHistory(); autoNest(); render(); setStatus('Re-nested '+items.length+' design(s)', true); }
  autoNestBtn.addEventListener('click', runAutoNest);
  autoNestPopupBtn.addEventListener('click', runAutoNest);

  // Pop out the Auto Nest button into its own small floating, draggable
  // panel — same component style as the design duplicate popup — so it can
  // be parked anywhere on screen instead of living only in the sidebar.
  popoutAutoNestBtn.addEventListener('click', (e)=>{
    const popupW = 220, popupH = 90;
    const btnRect = popoutAutoNestBtn.getBoundingClientRect();
    const x = Math.max(8, Math.min(window.innerWidth - popupW - 8, btnRect.right + 12));
    const y = Math.max(8, Math.min(window.innerHeight - popupH - 8, btnRect.top));
    autoNestPopup.style.left = x+'px';
    autoNestPopup.style.top = y+'px';
    autoNestPopup.classList.add('show');
  });
  closeAutoNestPopupBtn.addEventListener('click', ()=>{ autoNestPopup.classList.remove('show'); });

  let autoNestPopupDrag = null;
  autoNestPopupHeader.addEventListener('mousedown', (e)=>{
    if(e.target.closest('#closeAutoNestPopup')) return;
    const rect = autoNestPopup.getBoundingClientRect();
    autoNestPopupDrag = { startMouseX: e.clientX, startMouseY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e)=>{
    if(!autoNestPopupDrag) return;
    const dx = e.clientX - autoNestPopupDrag.startMouseX;
    const dy = e.clientY - autoNestPopupDrag.startMouseY;
    const x = Math.max(0, Math.min(window.innerWidth-40, autoNestPopupDrag.startLeft + dx));
    const y = Math.max(0, Math.min(window.innerHeight-40, autoNestPopupDrag.startTop + dy));
    autoNestPopup.style.left = x+'px';
    autoNestPopup.style.top = y+'px';
  });
  window.addEventListener('mouseup', ()=>{ autoNestPopupDrag = null; });
  centerBtn.addEventListener('click', ()=>{ pushHistory(); centerAllDesigns(); render(); setStatus('Centered '+items.length+' design(s)', true); });
  clearBtn.addEventListener('click', ()=>{
    if(items.length) pushHistory();
    items = []; selectedId = null; multiSelected.clear(); updateMultiSelectUI(); sheetHeightIn = 2;
    render(); renderItemList(); hideInfo();
    setStatus('Waiting for designs'); exportBtn.disabled = true;
    exportCutlinesBtn.disabled = true;
    autoFillBtn.disabled = true;
  });
  marginInput.addEventListener('change', ()=>{
    GAP_IN = Math.max(0, +marginInput.value || 0.5);
    if(items.length){ autoNest(); render(); setStatus('Margin set to '+GAP_IN+'in — re-nested', true); }
  });

  function applyHeightMode(){
    heightMode = heightModeSel.value;
    const fixed = heightMode === 'fixed';
    fixedHeightRow.style.display = fixed ? '' : 'none';
    heightNote.style.display = fixed ? '' : 'none';
    if(fixed) fixedHeightIn = Math.max(2, Math.min(180, +fixedHeightInput.value || 60));
    recomputeSheetHeight();
    render();
    setStatus(fixed ? 'Sheet height fixed at '+fixedHeightIn+'in' : 'Sheet height set to auto (fits designs)', true);
  }
  heightModeSel.addEventListener('change', applyHeightMode);
  fixedHeightInput.addEventListener('change', ()=>{
    let v = Math.max(2, +fixedHeightInput.value || 60);
    if(v > 180){
      alert('Gang sheets over 180 inches long may export a large file and have errors.\n\nPlease keep sheets at 180 inches or less.');
      v = 180;
      fixedHeightInput.value = 180;
    }
    fixedHeightIn = v;
    recomputeSheetHeight();
    render();
    setStatus('Sheet height fixed at '+fixedHeightIn+'in', true);
  });
  autoFillBtn.addEventListener('click', ()=>{
    const src = items.find(i=>i.id===selectedId);
    if(!src) return;
    const perRow = Math.max(1, Math.floor((SHEET_WIDTH_IN - GAP_IN) / (src.wIn + GAP_IN)));
    const targetLen = Math.max(1, +fillLengthInput.value || 36);
    const rows = Math.max(1, Math.floor((targetLen - GAP_IN) / (src.hIn + GAP_IN)));
    const totalNeeded = perRow * rows;
    const toAdd = Math.max(0, totalNeeded - 1); // src itself already counts as one
    for(let i=0;i<toAdd;i++){
      items.push({
        id: ++idSeq, name: src.name, file: src.file, img: src.img,
        nativeW: src.nativeW, nativeH: src.nativeH, mode: src.mode, w1Canvas: src.w1Canvas,
        xIn: src.xIn, yIn: src.yIn, wIn: src.wIn, hIn: src.hIn, rotated: src.rotated, rotationLocked: src.rotationLocked, locked:false
      });
    }
    autoNest();
    render(); renderItemList();
    exportBtn.disabled = items.length===0;
    setStatus('Filled sheet with '+totalNeeded+' copies of '+src.name, true);
  });
  bgColorInput.addEventListener('input', ()=>{
    sheetBgColor = bgColorInput.value;
    render();
  });
  bleedInput.addEventListener('change', ()=>{
    bleedIn = Math.max(0, +bleedInput.value || 0.0625);
  });
  function updateCutlineExportAvailability(){
    exportCutlinesBtn.disabled = !items.some(it=>it.cutLine);
  }
  contractSel.addEventListener('change', ()=>{});

  // ---------- rendering ----------
  function render(){
    const wPx = Math.round(SHEET_WIDTH_IN * PX_PER_IN);
    const hPx = Math.round(sheetHeightIn * PX_PER_IN);
    sheetCanvas.width = wPx; sheetCanvas.height = hPx;
    sheetWrap.style.width = wPx+'px'; sheetWrap.style.height = hPx+'px';
    const ctx = sheetCanvas.getContext('2d');
    ctx.fillStyle = sheetBgColor;
    ctx.fillRect(0,0,wPx,hPx);
    // light checker to indicate print bleed / edges is unnecessary; keep plain white (paper)

    for(const it of items){
      if(it.rotated){
        const cx = (it.xIn + it.wIn/2) * PX_PER_IN;
        const cy = (it.yIn + it.hIn/2) * PX_PER_IN;
        const drawW = it.hIn * PX_PER_IN; // pre-rotation width == current footprint height
        const drawH = it.wIn * PX_PER_IN; // pre-rotation height == current footprint width
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(Math.PI/2);
        ctx.drawImage(it.img, -drawW/2, -drawH/2, drawW, drawH);
        ctx.restore();
      } else {
        ctx.drawImage(it.img, it.xIn*PX_PER_IN, it.yIn*PX_PER_IN, it.wIn*PX_PER_IN, it.hIn*PX_PER_IN);
      }
    }

    itemLayer.innerHTML = '';
    for(const it of items){
      const box = document.createElement('div');
      box.className = 'item-box' + (it.id===selectedId ? ' selected' : '') + (it.locked ? ' locked' : '') + (multiSelected.has(it.id) ? ' multi-selected' : '');
      box.style.left = (it.xIn*PX_PER_IN)+'px';
      box.style.top = (it.yIn*PX_PER_IN)+'px';
      box.style.width = (it.wIn*PX_PER_IN)+'px';
      box.style.height = (it.hIn*PX_PER_IN)+'px';
      box.dataset.id = it.id;
      const handle = document.createElement('div');
      handle.className = 'handle';
      handle.dataset.role = 'resize';
      box.appendChild(handle);
      itemLayer.appendChild(box);
    }

    sheetWidthStat.textContent = SHEET_WIDTH_IN.toFixed(2)+' in (fixed)';
    sheetHeightStat.textContent = sheetHeightIn.toFixed(2)+' in';
    sheetPxStat.textContent = Math.round(SHEET_WIDTH_IN*SHEET_DPI)+' × '+Math.round(sheetHeightIn*SHEET_DPI)+' px';

    if(selectedId) showInfo(items.find(i=>i.id===selectedId));
  }

  // One row per unique design name+size+lock-state — duplicates at the SAME
  // size and lock state don't add more rows, they just bump the count badge
  // on the existing row. Once a copy is resized to a different size, or
  // locked while its siblings aren't, it splits off into its own row (own
  // QTY of 1) since it's no longer identical stock. The row's data-id points
  // at the first instance in that group, which is what Duplicate/Remove/
  // Rename act on.
  function groupKey(it){
    return it.name + '@' + it.wIn.toFixed(2) + 'x' + it.hIn.toFixed(2) + (it.locked?'@locked':'');
  }
  function populateItemListContainer(container, thumbSize){
    thumbSize = thumbSize || 32;
    container.innerHTML = '';
    if(!items.length){ container.innerHTML = '<div class="empty-note">No designs yet.</div>'; return; }
    const groups = [];
    const groupIndex = {};
    for(const it of items){
      const key = groupKey(it);
      if(!(key in groupIndex)){
        groupIndex[key] = groups.length;
        groups.push({key, name: it.name, mode: it.mode, ids: []});
      }
      groups[groupIndex[key]].ids.push(it.id);
    }
    for(const g of groups){
      const repId = g.ids[0];
      const repItem = items.find(i=>i.id===repId);
      const row = document.createElement('div');
      row.className = 'item-row'+(g.ids.includes(selectedId)?' selected':'');
      row.dataset.id = repId;
      const countBadge = `<span class="badge qtyEdit" data-id="${repId}" title="Click to change quantity">×${g.ids.length}</span>`;
      const lockIcon = repItem && repItem.locked ? `<span title="Locked — skipped by Auto Nest" style="color:#ff4d4d;font-size:12px;flex:none;">🔒</span>` : '';
      row.innerHTML = `<canvas class="thumb" width="${thumbSize}" height="${thumbSize}"></canvas><span class="name" title="${g.name}">${g.name}</span>${lockIcon}<button class="rename" data-id="${repId}" title="Rename">✎</button>${countBadge}<span style="font-size:9px;color:var(--dim);font-family:var(--mono);flex:none;">${g.mode==='precomputed'?'W1 ✓':'PNG/SVG'}</span><button class="dup" data-id="${repId}" title="Duplicate">⧉</button><button class="rm" data-id="${repId}" title="Remove one">✕</button>`;
      container.appendChild(row);
      if(repItem && repItem.img){
        const thumbCanvas = row.querySelector('.thumb');
        const tctx = thumbCanvas.getContext('2d');
        const iw = repItem.img.naturalWidth || repItem.img.width || repItem.nativeW || 1;
        const ih = repItem.img.naturalHeight || repItem.img.height || repItem.nativeH || 1;
        const scale = Math.min(thumbSize/iw, thumbSize/ih);
        const dw = iw*scale, dh = ih*scale;
        const dx = (thumbSize-dw)/2, dy = (thumbSize-dh)/2;
        try{ tctx.drawImage(repItem.img, dx, dy, dw, dh); }catch(err){ /* image not decodable yet, leave checker backdrop visible */ }
      }
    }
  }
  function renderItemList(){
    itemCountEl.textContent = items.length ? items.length : '';
    populateItemListContainer(itemListEl, 32);
    if(itemsModalOverlay.style.display === 'flex'){
      populateItemListContainer(itemsModalList, 40);
    }
  }
  function handleItemListClick(e){
    const rm = e.target.closest('.rm');
    if(rm){ removeItem(+rm.dataset.id); return; }
    const dup = e.target.closest('.dup');
    if(dup){ duplicateItem(+dup.dataset.id); return; }
    const ren = e.target.closest('.rename');
    if(ren){ startRename(+ren.dataset.id, ren.closest('.item-row')); return; }
    const qty = e.target.closest('.qtyEdit');
    if(qty){ startQtyEdit(+qty.dataset.id, qty.closest('.item-row')); return; }
    const row = e.target.closest('.item-row');
    if(row){ selectItem(+row.dataset.id); }
  }

  // Click-to-edit quantity: swaps the ×N badge for a small number input in
  // place. Typing a bigger number duplicates more copies of this design;
  // typing a smaller number removes the extras (most-recently-added ones
  // first, so the original stays put). Auto Nest runs afterward to fit
  // whatever the new count is.
  function startQtyEdit(id, row){
    const repItem = items.find(i=>i.id===id);
    if(!repItem || !row) return;
    const key = groupKey(repItem);
    const groupIds = items.filter(i=>groupKey(i)===key).map(i=>i.id);
    const oldCount = groupIds.length;
    const badge = row.querySelector('.qtyEdit');
    if(!badge) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.className = 'qtyInput';
    input.value = oldCount;
    badge.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = ()=>{
      if(committed) return;
      committed = true;
      const newCount = Math.max(1, Math.round(+input.value) || oldCount);
      if(newCount !== oldCount){
        const currentIds = items.filter(i=>groupKey(i)===key).map(i=>i.id); // re-check in case anything shifted
        const src = items.find(i=>i.id===currentIds[0]);
        if(newCount > currentIds.length){
          const toAdd = newCount - currentIds.length;
          for(let k=0;k<toAdd;k++){
            items.push({
              id: ++idSeq, name: src.name, file: src.file, img: src.img,
              nativeW: src.nativeW, nativeH: src.nativeH, mode: src.mode, w1Canvas: src.w1Canvas,
              xIn: src.xIn, yIn: src.yIn, wIn: src.wIn, hIn: src.hIn, rotated: src.rotated,
              rotationLocked: src.rotationLocked, locked:false
            });
          }
        } else {
          const toRemove = currentIds.length - newCount;
          const removeIds = new Set(currentIds.slice(currentIds.length - toRemove));
          items = items.filter(i=>!removeIds.has(i.id));
          if(removeIds.has(selectedId)) selectedId = null;
        }
        autoNest();
        exportBtn.disabled = items.length===0;
        updateCutlineExportAvailability();
        setStatus('Set '+src.name+' to ×'+newCount, true);
      }
      render(); renderItemList();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e)=>{
      if(e.key==='Enter') input.blur();
      if(e.key==='Escape'){ committed = true; render(); renderItemList(); }
    });
  }

  // Inline rename: swaps the row's name span for a text input in place
  // (no full list re-render while typing, so focus/caret aren't lost).
  // Renaming applies to every item sharing this exact name+size group, so
  // the QTY badge carries over intact under the new name.
  function startRename(id, row){
    const it = items.find(i=>i.id===id);
    if(!it || !row) return;
    const nameSpan = row.querySelector('.name');
    if(!nameSpan) return;
    const oldName = it.name;
    const key = groupKey(it);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'renameInput';
    input.value = oldName;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let committed = false;
    const commit = ()=>{
      if(committed) return;
      committed = true;
      const newName = input.value.trim() || oldName;
      if(newName !== oldName){
        for(const other of items){
          if(groupKey(other) === key) other.name = newName;
        }
        setStatus('Renamed to '+newName, true);
      }
      renderItemList();
    };
    input.addEventListener('keydown', (e)=>{
      if(e.key==='Enter'){ input.blur(); }
      else if(e.key==='Escape'){ committed = true; renderItemList(); }
    });
    input.addEventListener('blur', commit);
  }
  itemListEl.addEventListener('click', handleItemListClick);
  itemsModalList.addEventListener('click', handleItemListClick);
  expandItemsBtn.addEventListener('click', ()=>{
    itemsModalOverlay.style.display = 'flex';
    populateItemListContainer(itemsModalList, 40);
  });
  closeItemsModalBtn.addEventListener('click', ()=>{ itemsModalOverlay.style.display = 'none'; });

  // draggable by its header, same pattern as the info panel — this floats on
  // top without blocking the rest of the screen, so it's fine to leave open
  // while working the sheet
  let itemsModalDrag = null;
  document.querySelector('.modal-header').addEventListener('mousedown', (e)=>{
    if(e.target.closest('#closeItemsModal')) return;
    const rect = itemsModalOverlay.getBoundingClientRect();
    itemsModalDrag = { startMouseX: e.clientX, startMouseY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e)=>{
    if(!itemsModalDrag) return;
    const dx = e.clientX - itemsModalDrag.startMouseX;
    const dy = e.clientY - itemsModalDrag.startMouseY;
    const x = Math.max(0, Math.min(window.innerWidth-40, itemsModalDrag.startLeft + dx));
    const y = Math.max(0, Math.min(window.innerHeight-40, itemsModalDrag.startTop + dy));
    itemsModalOverlay.style.left = x+'px';
    itemsModalOverlay.style.top = y+'px';
    itemsModalOverlay.style.right = 'auto';
  });
  window.addEventListener('mouseup', ()=>{ itemsModalDrag = null; });

  function duplicateItem(id){
    const src = items.find(i=>i.id===id);
    if(!src) return;
    pushHistory();
    const copy = {
      id: ++idSeq, name: src.name, file: src.file, img: src.img,
      nativeW: src.nativeW, nativeH: src.nativeH, mode: src.mode, w1Canvas: src.w1Canvas,
      xIn: src.xIn, yIn: src.yIn, wIn: src.wIn, hIn: src.hIn, rotated: src.rotated, rotationLocked: src.rotationLocked, locked:false
    };
    items.push(copy);
    autoNest();
    selectItem(copy.id);
    setStatus('Duplicated '+src.name, true);
  }

  function removeItem(id){
    pushHistory();
    items = items.filter(i=>i.id!==id);
    if(selectedId===id) selectedId = null;
    recomputeSheetHeight();
    render(); renderItemList(); hideInfo();
    exportBtn.disabled = items.length===0;
    updateCutlineExportAvailability();
    setStatus(items.length ? items.length+' design(s) on sheet' : 'Waiting for designs', true);
  }

  function selectItem(id){
    selectedId = id;
    render(); renderItemList();
    const it = items.find(i=>i.id===id);
    if(it) showInfo(it);
    autoFillBtn.disabled = !it;
  }

  // ---------- info panel ----------
  let aspectLocked = true;
  let infoMinimized = false;
  let infoPanelPos = null; // {x,y} in viewport px once the user drags it; null = use CSS default
  let infoDrag = null;
  function showInfo(it){
    infoPanel.style.display = 'block';
    infoPanel.classList.toggle('minimized', infoMinimized);
    if(infoPanelPos){
      infoPanel.style.left = infoPanelPos.x+'px';
      infoPanel.style.top = infoPanelPos.y+'px';
    }
    // When rotated, wIn/hIn are swapped relative to the native image, so the
    // native dimension used for this calculation must swap too — otherwise
    // rotating an item (with no actual resize) would incorrectly show a
    // different DPI than before, even though nothing about its resolution
    // actually changed.
    const effectiveNativeW = it.rotated ? it.nativeH : it.nativeW;
    const dpi = Math.round(effectiveNativeW / it.wIn);
    // Note for accuracy: DPI actually goes UP when a design is shrunk (same
    // pixel data packed into less physical space = more dots per inch) and
    // DOWN when enlarged — so this indicator mainly catches designs sized
    // too big for their native resolution, not too small.
    let dpiText, dpiColor;
    if(dpi >= 300){ dpiText = '300+ DPI'; dpiColor = 'var(--good)'; }
    else if(dpi >= 250){ dpiText = dpi + ' DPI'; dpiColor = '#fbbf47'; }
    else { dpiText = dpi + ' DPI'; dpiColor = 'var(--danger)'; }
    infoPanel.innerHTML = `
      <div class="head" id="infoHead">
        <div class="name">${it.name}</div>
        <button class="minBtn" id="minToggle" title="${infoMinimized?'Expand':'Minimize'}">${infoMinimized?'▢':'—'}</button>
      </div>
      <div class="body">
        <div class="line"><span>Source</span><b>${it.mode==='precomputed' ? 'TIFF (W1 baked in)' : 'PNG/SVG (choked at export)'}</b></div>
        <div class="line"><span>Native</span><b>${it.nativeW} × ${it.nativeH} px</b></div>
        <div class="line"><span>Placed size</span><b>${it.wIn.toFixed(2)} × ${it.hIn.toFixed(2)} in</b></div>
        <div class="line"><span>Effective DPI</span><b style="color:${dpiColor};">${dpiText}</b></div>
        <div class="dims">
          <input type="number" step="0.05" min="0.1" id="wInput" value="${it.wIn.toFixed(2)}"> in W
          <input type="number" step="0.05" min="0.1" id="hInput" value="${it.hIn.toFixed(2)}"> in H
        </div>
        <div class="lockrow"><input type="checkbox" id="lockAspect" ${aspectLocked?'checked':''}> Lock aspect ratio</div>
        <div class="lockrow"><input type="checkbox" id="cutLineToggle" ${it.cutLine?'checked':''}> Cut Line (sticker mode)</div>
        <button class="btn small full" id="rotateBtn" style="margin-top:9px;">↻ Rotate 90°${it.rotated?' (currently rotated)':''}</button>
        <div class="lockrow" style="margin-top:9px;"><input type="checkbox" id="rotationLockToggle" ${it.rotationLocked?'checked':''}> Lock rotation (Auto Nest won't change it)</div>
      </div>
    `;
    infoPanel.querySelector('#minToggle').addEventListener('click', ()=>{
      infoMinimized = !infoMinimized;
      showInfo(it);
    });
    infoPanel.querySelector('#infoHead').addEventListener('mousedown', (e)=>{
      if(e.target.closest('#minToggle')) return; // let the minimize button work normally
      const rect = infoPanel.getBoundingClientRect();
      infoDrag = { startMouseX: e.clientX, startMouseY: e.clientY, startLeft: rect.left, startTop: rect.top };
      e.preventDefault();
    });
    if(infoMinimized) return; // body isn't rendered/interactive while collapsed
    infoPanel.querySelector('#rotateBtn').addEventListener('click', ()=>{
      const cx = it.xIn + it.wIn/2, cy = it.yIn + it.hIn/2; // keep the item centered in place when flipping
      const newW = it.hIn, newH = it.wIn;
      it.wIn = newW; it.hIn = newH;
      it.rotated = !it.rotated;
      it.rotationLocked = true; // manually rotating implies you want it to stay this way
      it.xIn = Math.max(0, cx - newW/2);
      it.yIn = Math.max(0, cy - newH/2);
      recomputeSheetHeight(); render(); showInfo(it);
    });
    infoPanel.querySelector('#rotationLockToggle').addEventListener('change', (e)=>{
      it.rotationLocked = e.target.checked;
    });
    infoPanel.querySelector('#cutLineToggle').addEventListener('change', (e)=>{
      it.cutLine = e.target.checked;
      updateCutlineExportAvailability();
    });
    const wInput = infoPanel.querySelector('#wInput');
    const hInput = infoPanel.querySelector('#hInput');
    const lockBox = infoPanel.querySelector('#lockAspect');
    const ratio = it.rotated ? (it.nativeW/it.nativeH) : (it.nativeH/it.nativeW);
    lockBox.addEventListener('change', ()=>{ aspectLocked = lockBox.checked; });
    wInput.addEventListener('change', ()=>{
      const maxPossibleW = Math.max(0.1, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
      const v = Math.min(maxPossibleW, Math.max(0.1, +wInput.value||it.wIn));
      it.wIn = v;
      if(aspectLocked) it.hIn = v*ratio;
      // if the design no longer fits at its current x with this new width,
      // slide it left just enough to fit rather than silently capping the size
      it.xIn = Math.min(it.xIn, Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn));
      recomputeSheetHeight(); render(); showInfo(it);
    });
    hInput.addEventListener('change', ()=>{
      const v = Math.max(0.1, +hInput.value||it.hIn);
      let newW = aspectLocked ? v/ratio : it.wIn;
      const maxPossibleW = Math.max(0.1, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
      if(newW > maxPossibleW){ newW = maxPossibleW; }
      it.hIn = aspectLocked ? newW*ratio : v;
      it.wIn = newW;
      it.xIn = Math.min(it.xIn, Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn));
      recomputeSheetHeight(); render(); showInfo(it);
    });
  }
  window.addEventListener('mousemove', (e)=>{
    if(!infoDrag) return;
    const dx = e.clientX - infoDrag.startMouseX;
    const dy = e.clientY - infoDrag.startMouseY;
    const x = Math.max(0, Math.min(window.innerWidth-40, infoDrag.startLeft + dx));
    const y = Math.max(0, Math.min(window.innerHeight-40, infoDrag.startTop + dy));
    infoPanelPos = {x, y};
    infoPanel.style.left = x+'px';
    infoPanel.style.top = y+'px';
  });
  window.addEventListener('mouseup', ()=>{ infoDrag = null; });
  function hideInfo(){ infoPanel.style.display = 'none'; }


  // ---------- drag / resize on canvas ----------
  itemLayer.addEventListener('mousedown', (e)=>{
    const box = e.target.closest('.item-box');
    if(!box) return;
    const id = +box.dataset.id;
    const it = items.find(i=>i.id===id);
    if(!it) return;

    // Shift+click: toggle this design in/out of the multi-selection (hand-pick
    // several designs one at a time). Doesn't start a drag.
    if(e.shiftKey){
      e.preventDefault();
      // if there's a single active selection, fold it into the multi-set first
      if(selectedId != null && !multiSelected.size){
        multiSelected.add(selectedId);
        selectedId = null; hideInfo();
      }
      if(multiSelected.has(id)) multiSelected.delete(id);
      else multiSelected.add(id);
      // a lone remaining selection collapses back to a normal single-select
      if(multiSelected.size === 1){
        const only = [...multiSelected][0];
        multiSelected.clear();
        selectItem(only);
      }
      updateMultiSelectUI();
      render(); renderItemList();
      return;
    }

    pushHistory(); // snapshot before a potential move/resize (undoable)
    const isHandle = e.target.dataset.role === 'resize';
    const rect = sheetWrap.getBoundingClientRect();
    if(!isHandle && multiSelected.has(id) && multiSelected.size>1){
      // dragging any item that's part of an active multi-selection moves
      // the whole group together, preserving each item's relative position
      drag = {
        mode:'move', id, group:true,
        startMouseXIn: (e.clientX-rect.left)/PX_PER_IN,
        startMouseYIn: (e.clientY-rect.top)/PX_PER_IN,
        groupStart: [...multiSelected].map(gid=>{
          const g = items.find(i=>i.id===gid);
          return {id:gid, startX:g.xIn, startY:g.yIn, wIn:g.wIn, hIn:g.hIn, locked:g.locked};
        }),
        startClientX: e.clientX, startClientY: e.clientY, moved: false
      };
    } else {
      selectItem(id);
      if(multiSelected.size){ multiSelected.clear(); updateMultiSelectUI(); }
      drag = {
        mode: isHandle ? 'resize' : 'move',
        id,
        startMouseXIn: (e.clientX-rect.left)/PX_PER_IN,
        startMouseYIn: (e.clientY-rect.top)/PX_PER_IN,
        startX: it.xIn, startY: it.yIn, startW: it.wIn, startH: it.hIn,
        ratio: it.rotated ? (it.nativeW/it.nativeH) : (it.nativeH/it.nativeW),
        startClientX: e.clientX, startClientY: e.clientY, moved: false
      };
    }
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e)=>{
    if(!drag) return;
    if(Math.abs(e.clientX-drag.startClientX) > 3 || Math.abs(e.clientY-drag.startClientY) > 3) drag.moved = true;
    const rect = sheetWrap.getBoundingClientRect();
    const mouseXIn = (e.clientX-rect.left)/PX_PER_IN;
    const mouseYIn = (e.clientY-rect.top)/PX_PER_IN;
    const dx = mouseXIn - drag.startMouseXIn;
    const dy = mouseYIn - drag.startMouseYIn;
    if(drag.group){
      // clamp the shared delta so NO item in the group can be dragged past
      // the left/right/top margins
      let minDx = -Infinity, maxDx = Infinity, minDy = -Infinity;
      for(const g of drag.groupStart){
        if(g.locked) continue; // locked items never move, don't factor into the clamp
        minDx = Math.max(minDx, RESIZE_MARGIN_IN - g.startX);
        maxDx = Math.min(maxDx, (SHEET_WIDTH_IN-RESIZE_MARGIN_IN-g.wIn) - g.startX);
        minDy = Math.max(minDy, TOP_MARGIN_IN - g.startY);
      }
      const cdx = Math.min(maxDx, Math.max(minDx, dx));
      const cdy = Math.max(minDy, dy);
      for(const g of drag.groupStart){
        if(g.locked) continue;
        const it2 = items.find(i=>i.id===g.id);
        if(it2){ it2.xIn = g.startX+cdx; it2.yIn = g.startY+cdy; }
      }
    } else {
      const it = items.find(i=>i.id===drag.id);
      if(!it) return;
      if(drag.mode==='move'){
        const maxX = Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn);
        it.xIn = Math.min(maxX, Math.max(RESIZE_MARGIN_IN, drag.startX + dx));
        it.yIn = Math.max(TOP_MARGIN_IN, drag.startY + dy);
      } else {
        const maxPossibleW = Math.max(0.2, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
        const newW = Math.min(maxPossibleW, Math.max(0.2, drag.startW + dx));
        it.wIn = newW;
        it.hIn = newW*drag.ratio;
        it.xIn = Math.min(it.xIn, Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn));
      }
    }
    recomputeSheetHeight();
    render();
  });
  window.addEventListener('mouseup', (e)=>{
    if(drag && !drag.moved){
      // no actual movement — this was a click, not a drag; drop the snapshot
      // we optimistically pushed at mousedown so undo isn't cluttered
      if(history.length) history.pop();
      if(drag.mode==='move' && !drag.group){
        openDuplicatePopup(drag.id, e.clientX, e.clientY);
      }
    }
    drag = null;
  });

  // ---------- design popup (plain click on a design) ----------
  // A small, non-blocking popup near the click point — draggable by its
  // header, same pattern as the Items panel — with quick access to size,
  // rotation, and duplicate right where you clicked, so resizing/rotating/
  // duplicating a design doesn't require a separate trip to the info panel.
  function openDuplicatePopup(id, clientX, clientY){
    const it = items.find(i=>i.id===id);
    if(!it) return;
    duplicatePopup.dataset.targetId = id;
    const ratio = it.rotated ? (it.nativeW/it.nativeH) : (it.nativeH/it.nativeW);
    duplicatePopupBody.innerHTML = `
      <div class="name">${it.name}</div>
      <div class="dims">
        <input type="number" step="0.05" min="0.1" id="popupWInput" value="${it.wIn.toFixed(2)}"> in W
        <input type="number" step="0.05" min="0.1" id="popupHInput" value="${it.hIn.toFixed(2)}"> in H
      </div>
      <label class="lockrow"><input type="checkbox" id="popupLockAspect" ${aspectLocked?'checked':''}> Lock aspect ratio</label>
      <div class="rotateRow"><button class="btn small full" id="popupRotateBtn">↻ Rotate 90°${it.rotated?' (currently rotated)':''}</button></div>
      <div class="float-popup-actions" style="margin-bottom:8px;">
        <button class="btn small full" id="popupLockBtn">${it.locked?'🔓 Unlock':'🔒 Lock (skip Auto Nest)'}</button>
      </div>
      <div class="float-popup-actions">
        <button class="btn small" id="confirmDuplicateBtn">Duplicate</button>
        <button class="btn small danger" id="popupDeleteBtn">Delete</button>
        <button class="btn small danger" id="cancelDuplicateBtn">Cancel</button>
      </div>
    `;
    // Sits just off the left edge of the gang sheet (never over the artwork/sheet
    // itself), at roughly the same height as the design that was clicked.
    const popupW = 250, popupH = 305; // approx, before layout — good enough to keep it on-screen
    const gap = 16;
    const sheetRect = sheetWrap.getBoundingClientRect();
    const x = Math.max(8, sheetRect.left - popupW - gap);
    const y = Math.max(8, Math.min(window.innerHeight - popupH - 8, (clientY||sheetRect.top) - popupH/2));
    duplicatePopup.style.left = x+'px';
    duplicatePopup.style.top = y+'px';
    duplicatePopup.classList.add('show');

    const wInput = duplicatePopupBody.querySelector('#popupWInput');
    const hInput = duplicatePopupBody.querySelector('#popupHInput');
    const lockBox = duplicatePopupBody.querySelector('#popupLockAspect');
    lockBox.addEventListener('change', ()=>{ aspectLocked = lockBox.checked; });
    wInput.addEventListener('change', ()=>{
      const maxPossibleW = Math.max(0.1, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
      const v = Math.min(maxPossibleW, Math.max(0.1, +wInput.value||it.wIn));
      it.wIn = v;
      if(aspectLocked) it.hIn = v*ratio;
      it.xIn = Math.min(it.xIn, Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn));
      recomputeSheetHeight(); render(); renderItemList();
      hInput.value = it.hIn.toFixed(2);
    });
    hInput.addEventListener('change', ()=>{
      const v = Math.max(0.1, +hInput.value||it.hIn);
      let newW = aspectLocked ? v/ratio : it.wIn;
      const maxPossibleW = Math.max(0.1, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
      if(newW > maxPossibleW){ newW = maxPossibleW; }
      it.hIn = aspectLocked ? newW*ratio : v;
      it.wIn = newW;
      it.xIn = Math.min(it.xIn, Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn));
      recomputeSheetHeight(); render(); renderItemList();
      wInput.value = it.wIn.toFixed(2);
    });
    duplicatePopupBody.querySelector('#popupRotateBtn').addEventListener('click', ()=>{
      pushHistory();
      const cx = it.xIn + it.wIn/2, cy = it.yIn + it.hIn/2; // keep centered when flipping
      const newW = it.hIn, newH = it.wIn;
      it.wIn = newW; it.hIn = newH;
      it.rotated = !it.rotated;
      it.rotationLocked = true;
      it.xIn = Math.max(0, cx - newW/2);
      it.yIn = Math.max(0, cy - newH/2);
      recomputeSheetHeight(); render(); renderItemList();
      openDuplicatePopup(id, clientX, clientY); // rebuild so the rotated label/size stay current
    });
    duplicatePopupBody.querySelector('#popupLockBtn').addEventListener('click', ()=>{
      pushHistory();
      it.locked = !it.locked;
      if(it.locked){
        // guarantee the locked item itself is fully within the sheet's
        // margins before treating it as a fixed obstacle — otherwise an old
        // out-of-bounds position (e.g. from before drag clamping was fixed)
        // could let something else nest right on top of it
        const maxW = Math.max(0.2, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
        if(it.wIn > maxW) it.wIn = maxW;
        it.xIn = Math.min(Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn), Math.max(RESIZE_MARGIN_IN, it.xIn));
        it.yIn = Math.max(TOP_MARGIN_IN, it.yIn);
      }
      render(); renderItemList();
      setStatus(it.locked ? it.name+' locked — Auto Nest will leave it in place' : it.name+' unlocked', true);
      openDuplicatePopup(id, clientX, clientY); // rebuild so the button label stays current
    });
    duplicatePopupBody.querySelector('#confirmDuplicateBtn').addEventListener('click', ()=>{
      duplicateItem(id);
      // stays open on purpose — only the ✕ or Cancel button should dismiss it,
      // so you can duplicate the same design multiple times in a row
    });
    duplicatePopupBody.querySelector('#popupDeleteBtn').addEventListener('click', ()=>{
      closeDuplicatePopup();
      removeItem(id);
    });
    duplicatePopupBody.querySelector('#cancelDuplicateBtn').addEventListener('click', closeDuplicatePopup);
  }
  function closeDuplicatePopup(){
    duplicatePopup.classList.remove('show');
  }
  closeDuplicatePopupBtn.addEventListener('click', closeDuplicatePopup);

  let duplicatePopupDrag = null;
  duplicatePopupHeader.addEventListener('mousedown', (e)=>{
    if(e.target.closest('#closeDuplicatePopup')) return;
    const rect = duplicatePopup.getBoundingClientRect();
    duplicatePopupDrag = { startMouseX: e.clientX, startMouseY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e)=>{
    if(!duplicatePopupDrag) return;
    const dx = e.clientX - duplicatePopupDrag.startMouseX;
    const dy = e.clientY - duplicatePopupDrag.startMouseY;
    const x = Math.max(0, Math.min(window.innerWidth-40, duplicatePopupDrag.startLeft + dx));
    const y = Math.max(0, Math.min(window.innerHeight-40, duplicatePopupDrag.startTop + dy));
    duplicatePopup.style.left = x+'px';
    duplicatePopup.style.top = y+'px';
  });
  window.addEventListener('mouseup', ()=>{ duplicatePopupDrag = null; });

  // click empty area to deselect, or drag across empty area to multi-select
  let marquee = null;
  function startMarquee(e){
    // only when the click is on empty sheet, not on a design box
    if(e.target.closest('.item-box')) return;
    const rect = sheetWrap.getBoundingClientRect();
    marquee = {
      startXIn: (e.clientX-rect.left)/PX_PER_IN,
      startYIn: (e.clientY-rect.top)/PX_PER_IN,
      startClientX: e.clientX, startClientY: e.clientY, moved: false
    };
  }
  // listen on both the itemLayer (which sits on top of the sheet) and the
  // wrapper, so a drag starting on any empty part of the sheet is caught
  itemLayer.addEventListener('mousedown', startMarquee);
  sheetWrap.addEventListener('mousedown', (e)=>{
    if(e.target===sheetCanvas) startMarquee(e);
  });
  window.addEventListener('mousemove', (e)=>{
    if(!marquee) return;
    if(Math.abs(e.clientX-marquee.startClientX) > 3 || Math.abs(e.clientY-marquee.startClientY) > 3) marquee.moved = true;
    if(!marquee.moved) return;
    const rect = sheetWrap.getBoundingClientRect();
    const curXIn = (e.clientX-rect.left)/PX_PER_IN, curYIn = (e.clientY-rect.top)/PX_PER_IN;
    const x0 = Math.min(marquee.startXIn, curXIn), x1 = Math.max(marquee.startXIn, curXIn);
    const y0 = Math.min(marquee.startYIn, curYIn), y1 = Math.max(marquee.startYIn, curYIn);
    marqueeBox.style.display = 'block';
    marqueeBox.style.left = (x0*PX_PER_IN)+'px';
    marqueeBox.style.top = (y0*PX_PER_IN)+'px';
    marqueeBox.style.width = ((x1-x0)*PX_PER_IN)+'px';
    marqueeBox.style.height = ((y1-y0)*PX_PER_IN)+'px';
  });
  window.addEventListener('mouseup', (e)=>{
    if(!marquee) return;
    if(marquee.moved){
      const rect = sheetWrap.getBoundingClientRect();
      const curXIn = (e.clientX-rect.left)/PX_PER_IN, curYIn = (e.clientY-rect.top)/PX_PER_IN;
      const x0 = Math.min(marquee.startXIn, curXIn), x1 = Math.max(marquee.startXIn, curXIn);
      const y0 = Math.min(marquee.startYIn, curYIn), y1 = Math.max(marquee.startYIn, curYIn);
      const hits = items.filter(it => it.xIn < x1 && it.xIn+it.wIn > x0 && it.yIn < y1 && it.yIn+it.hIn > y0);
      if(hits.length === 1){
        multiSelected.clear(); updateMultiSelectUI();
        selectItem(hits[0].id);
      } else {
        multiSelected = new Set(hits.map(it=>it.id));
        selectedId = null; hideInfo(); autoFillBtn.disabled = true;
        updateMultiSelectUI();
        render(); renderItemList();
      }
    } else {
      selectedId=null; render(); renderItemList(); hideInfo(); autoFillBtn.disabled = true;
      if(multiSelected.size){ multiSelected.clear(); updateMultiSelectUI(); }
    }
    marqueeBox.style.display = 'none';
    marquee = null;
  });

  // Floating "N selected" toolbar for bulk actions on a marquee selection
  function updateMultiSelectUI(){
    if(multiSelected.size > 1){
      multiSelectCount.textContent = multiSelected.size+' selected';
      multiSelectPopup.classList.add('show');
      const sheetRect = sheetWrap.getBoundingClientRect();
      multiSelectPopup.style.left = Math.max(8, sheetRect.left + 24)+'px';
      multiSelectPopup.style.top = Math.max(8, sheetRect.top + 24)+'px';
    } else {
      multiSelected.clear();
      multiSelectPopup.classList.remove('show');
    }
  }
  closeMultiSelectPopupBtn.addEventListener('click', ()=>{ multiSelected.clear(); updateMultiSelectUI(); render(); });
  multiSelectLockBtn.addEventListener('click', ()=>{
    pushHistory();
    for(const id of multiSelected){
      const it = items.find(i=>i.id===id);
      if(!it || it.locked) continue;
      it.locked = true;
      const maxW = Math.max(0.2, SHEET_WIDTH_IN - 2*RESIZE_MARGIN_IN);
      if(it.wIn > maxW) it.wIn = maxW;
      it.xIn = Math.min(Math.max(RESIZE_MARGIN_IN, SHEET_WIDTH_IN - RESIZE_MARGIN_IN - it.wIn), Math.max(RESIZE_MARGIN_IN, it.xIn));
      it.yIn = Math.max(TOP_MARGIN_IN, it.yIn);
    }
    setStatus('Locked '+multiSelected.size+' design(s)', true);
    multiSelected.clear(); updateMultiSelectUI();
    render(); renderItemList();
  });
  multiSelectDeleteBtn.addEventListener('click', ()=>{
    pushHistory();
    const count = multiSelected.size;
    items = items.filter(it=>!multiSelected.has(it.id));
    selectedId = null;
    multiSelected.clear(); updateMultiSelectUI();
    recomputeSheetHeight();
    render(); renderItemList(); hideInfo();
    exportBtn.disabled = items.length===0;
    updateCutlineExportAvailability();
    setStatus('Deleted '+count+' design(s)', true);
  });
  let multiSelectDrag = null;
  multiSelectPopupHeader.addEventListener('mousedown', (e)=>{
    if(e.target.closest('#closeMultiSelectPopup')) return;
    const rect = multiSelectPopup.getBoundingClientRect();
    multiSelectDrag = { startMouseX: e.clientX, startMouseY: e.clientY, startLeft: rect.left, startTop: rect.top };
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e)=>{
    if(!multiSelectDrag) return;
    const dx = e.clientX - multiSelectDrag.startMouseX, dy = e.clientY - multiSelectDrag.startMouseY;
    const x = Math.max(0, Math.min(window.innerWidth-40, multiSelectDrag.startLeft + dx));
    const y = Math.max(0, Math.min(window.innerHeight-40, multiSelectDrag.startTop + dy));
    multiSelectPopup.style.left = x+'px';
    multiSelectPopup.style.top = y+'px';
  });
  window.addEventListener('mouseup', ()=>{ multiSelectDrag = null; });

  // ---------- zoom ----------
  function setZoom(px){
    PX_PER_IN = Math.max(20, Math.min(120, px));
    zoomLabel.textContent = Math.round(PX_PER_IN/60*100)+'%';
    render();
  }
  zoomInBtn.addEventListener('click', ()=>setZoom(PX_PER_IN+10));
  zoomOutBtn.addEventListener('click', ()=>setZoom(PX_PER_IN-10));

  render();

  // ---------- keyboard shortcuts ----------
  // Delete / Backspace: remove the selected design(s).
  // Ctrl/Cmd + Z: undo the last change.
  // Shortcuts are ignored while the user is typing in a text/number field or
  // renaming, so they never interfere with editing values.
  document.addEventListener('keydown', (e)=>{
    const el = document.activeElement;
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
    if(typing) return;

    // Undo — Ctrl+Z (Windows/Linux) or Cmd+Z (Mac)
    if((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')){
      e.preventDefault();
      undo();
      return;
    }

    // Delete / Backspace — remove selected design(s)
    if(e.key === 'Delete' || e.key === 'Backspace'){
      if(multiSelected.size > 0){
        e.preventDefault();
        pushHistory();
        const count = multiSelected.size;
        items = items.filter(it=>!multiSelected.has(it.id));
        selectedId = null;
        multiSelected.clear(); updateMultiSelectUI();
        recomputeSheetHeight();
        render(); renderItemList(); hideInfo();
        exportBtn.disabled = items.length===0;
        updateCutlineExportAvailability();
        setStatus('Deleted '+count+' design(s)', true);
      } else if(selectedId != null){
        e.preventDefault();
        removeItem(selectedId);
      }
    }
  });

  // "All Items" panel is open by default so it's visible as soon as the app loads
  itemsModalOverlay.style.display = 'flex';
  populateItemListContainer(itemsModalList, 40);

function buildAlphaNamesIRB(names){
    const dataBytes = [];
    for(const nm of names){
      const nameBytes = Array.from(new TextEncoder().encode(nm));
      dataBytes.push(nameBytes.length, ...nameBytes);
    }
    const size = dataBytes.length;
    const dataPadded = size % 2 ? [...dataBytes, 0] : dataBytes.slice();
    const total = 4 + 2 + 2 + 4 + dataPadded.length; // sig + id + emptyName + size + data
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let p = 0;
    buf.set([0x38,0x42,0x49,0x4D], p); p += 4; // '8BIM'
    dv.setUint16(p, 1006, false); p += 2;      // Alpha Channel Names resource id
    p += 2;                                     // empty resource-block name (already zeroed)
    dv.setUint32(p, size, false); p += 4;
    buf.set(dataPadded, p);
    return buf;
  }

  // Photoshop "DisplayInfo" resource (id 1077) — sets the on-screen swatch
  // color/opacity for a channel. Reverse-engineered from a real Photoshop
  // export: 4-byte version(1), then colorSpace(HSB=1), H, S, B (16-bit each),
  // padding, opacity(0-100), mode. H=0,S=0,B=max = white, matching the
  // reference file exactly, so the channel opens already white instead of
  // Photoshop's default red.
  function buildDisplayInfoIRB(){
    const payload = new Uint8Array(17);
    const dv = new DataView(payload.buffer);
    dv.setUint32(0, 1, false);      // version
    dv.setUint16(4, 1, false);      // colorSpace = HSB
    dv.setUint16(6, 0, false);      // H
    dv.setUint16(8, 0, false);      // S
    dv.setUint16(10, 0xFFFF, false);// B = max -> white
    dv.setUint16(12, 0, false);     // padding
    dv.setUint16(14, 100, false);   // opacity %
    payload[16] = 2;                // mode (matches reference)

    const total = 4 + 2 + 2 + 4 + payload.length; // sig + id + emptyName + size + data (17 is odd -> pad)
    const totalPadded = (payload.length % 2) ? total + 1 : total;
    const buf = new Uint8Array(totalPadded);
    const bdv = new DataView(buf.buffer);
    let p = 0;
    buf.set([0x38,0x42,0x49,0x4D], p); p += 4; // '8BIM'
    bdv.setUint16(p, 1077, false); p += 2;     // DisplayInfo resource id
    p += 2;                                     // empty resource-block name
    bdv.setUint32(p, payload.length, false); p += 4;
    buf.set(payload, p);
    return buf;
  }

  function concatBytes(arrays){
    const total = arrays.reduce((s,a)=>s+a.length,0);
    const out = new Uint8Array(total);
    let p = 0;
    for(const a of arrays){ out.set(a, p); p += a.length; }
    return out;
  }

  // ---------- minimal baseline-TIFF encoder (uncompressed, 8-bit) ----------
  // Writes 5 samples per pixel: R, G, B, a real transparency channel (so
  // Photoshop's Layers panel shows the design with actual transparency, no
  // prompt), and a separate W1 channel (unspecified type, so Photoshop asks
  // Alpha-vs-Spot on open — pick Spot — and names it "W1" via the embedded
  // Photoshop resource). This keeps the design fully editable in Layers while
  // W1 lives independently in Channels.
  function encodeEditableTIFF(pixels5ch, width, height){
    const channels = 5; // R,G,B, transparency, W1
    const namesIrb = buildAlphaNamesIRB(['', 'W1']); // first name unused (real transparency), second names W1
    const colorIrb = buildDisplayInfoIRB(); // sets W1's on-screen swatch to white
    const irb = concatBytes([namesIrb, colorIrb]);

    // --- MULTIPLE STRIPS ---------------------------------------------------
    // A single strip holding the whole image works for small sheets, but on a
    // tall sheet it becomes hundreds of MB in ONE strip. Many RIPs (MainTop
    // included) can't handle a strip that large — they reject it (blank
    // output) or misread the image dimensions. The TIFF spec's answer, and
    // what Photoshop does, is to split the pixel data into many strips of a
    // handful of rows each. This changes only the file's internal layout; the
    // pixel data, channels, and 300-DPI resolution are all identical.
    const bytesPerRow = width * channels;
    // Target a moderate strip size: big enough that we don't produce tens of
    // thousands of tiny strips on a tall sheet (which some RIPs dislike as
    // much as one huge strip), but small enough that no single strip is
    // unwieldy. ~256KB per strip is a safe middle ground every RIP handles.
    const TARGET_STRIP_BYTES = 256 * 1024;
    let rowsPerStrip = Math.max(1, Math.floor(TARGET_STRIP_BYTES / bytesPerRow));
    if(rowsPerStrip > height) rowsPerStrip = height;
    const numStrips = Math.ceil(height / rowsPerStrip);

    const numEntries = 14; // 256,257,258,259,262,273,277,278,279,282,283,296,338,34377
    const ifdStart = 8;
    const ifdSize = 2 + numEntries*12 + 4;
    let offset = ifdStart + ifdSize;

    const bitsPerSampleOffset = offset; offset += channels*2; if(offset%2) offset++;
    const xresOffset = offset; offset += 8;
    const yresOffset = offset; offset += 8;
    // StripOffsets and StripByteCounts each need an out-of-line array when
    // there's more than one strip (they don't fit in the 4-byte IFD slot).
    const stripOffsetsArrOffset = offset; offset += numStrips*4; if(offset%2) offset++;
    const stripByteCountsArrOffset = offset; offset += numStrips*4; if(offset%2) offset++;
    const irbOffset = offset; offset += irb.length; if(offset%2) offset++;

    // strip pixel data starts here; record each strip's offset and length
    const stripStart = offset;
    const stripOffsets = new Array(numStrips);
    const stripByteCounts = new Array(numStrips);
    for(let s=0; s<numStrips; s++){
      const startRow = s*rowsPerStrip;
      const rowsThis = Math.min(rowsPerStrip, height - startRow);
      const lenThis = rowsThis * bytesPerRow;
      stripOffsets[s] = offset;
      stripByteCounts[s] = lenThis;
      offset += lenThis;
    }

    const buf = new ArrayBuffer(offset);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);

    dv.setUint8(0,0x49); dv.setUint8(1,0x49); // 'II' little-endian
    dv.setUint16(2,42,true);
    dv.setUint32(4,ifdStart,true);

    let p = ifdStart;
    dv.setUint16(p,numEntries,true); p+=2;

    function entry(tag,type,count,val,isPointer){
      dv.setUint16(p,tag,true); p+=2;
      dv.setUint16(p,type,true); p+=2;
      dv.setUint32(p,count,true); p+=4;
      if(isPointer){ dv.setUint32(p,val,true); }
      else if(type===3){ dv.setUint16(p,val,true); dv.setUint16(p+2,0,true); }
      else { dv.setUint32(p,val,true); }
      p+=4;
    }

    // For StripOffsets/StripByteCounts: with 1 strip the value sits inline;
    // with many strips it's a pointer to the array we laid out above.
    const stripsInline = (numStrips === 1);

    entry(256,4,1,width,false);          // ImageWidth
    entry(257,4,1,height,false);         // ImageLength
    entry(258,3,channels,bitsPerSampleOffset,true); // BitsPerSample
    entry(259,3,1,1,false);              // Compression = none
    entry(262,3,1,2,false);              // PhotometricInterpretation = RGB
    entry(273,4,numStrips, stripsInline ? stripOffsets[0] : stripOffsetsArrOffset, !stripsInline); // StripOffsets
    entry(277,3,1,channels,false);       // SamplesPerPixel
    entry(278,4,1,rowsPerStrip,false);   // RowsPerStrip
    entry(279,4,numStrips, stripsInline ? stripByteCounts[0] : stripByteCountsArrOffset, !stripsInline); // StripByteCounts
    entry(282,5,1,xresOffset,true);      // XResolution
    entry(283,5,1,yresOffset,true);      // YResolution
    entry(296,3,1,2,false);              // ResolutionUnit = inch

    // ExtraSamples: count=2, both SHORTs fit inline (4 bytes) —
    // [0]=2 (unassociated alpha -> Photoshop treats as real layer transparency, no prompt)
    // [1]=0 (unspecified -> Photoshop asks Alpha/Spot for this one; pick Spot -> becomes W1)
    dv.setUint16(p,338,true); p+=2;
    dv.setUint16(p,3,true); p+=2;
    dv.setUint32(p,2,true); p+=4;
    dv.setUint16(p,2,true);
    dv.setUint16(p+2,0,true);
    p+=4;

    entry(34377,1,irb.length,irbOffset,true); // Photoshop Image Resources (names W1)

    dv.setUint32(p,0,true); p+=4; // no next IFD

    let bp = bitsPerSampleOffset;
    for(let i=0;i<channels;i++){ dv.setUint16(bp,8,true); bp+=2; }
    dv.setUint32(xresOffset,300,true); dv.setUint32(xresOffset+4,1,true);
    dv.setUint32(yresOffset,300,true); dv.setUint32(yresOffset+4,1,true);

    // write the strip offset/count arrays (only read when >1 strip, but
    // harmless to always write)
    for(let s=0; s<numStrips; s++){
      dv.setUint32(stripOffsetsArrOffset + s*4, stripOffsets[s], true);
      dv.setUint32(stripByteCountsArrOffset + s*4, stripByteCounts[s], true);
    }

    u8.set(irb, irbOffset);

    // copy the pixel rows into their strips. Since strips are contiguous and
    // in row order, this is just one linear copy of the whole buffer starting
    // at stripStart — the per-strip offsets we recorded already point into it.
    u8.set(pixels5ch, stripStart);
    return buf;
  }

  // separable min filter (grayscale erosion), treats out-of-bounds as 0
  function slidingMin(arr, n, radius){
    const result = new Float32Array(n);
    const dequeIdx = new Int32Array(n + 2*radius + 2);
    let head=0, tail=0;
    const getVal = (idx)=> (idx<0||idx>=n) ? 0 : arr[idx];
    for(let i=-radius; i<n+radius; i++){
      const v = getVal(i);
      while(tail>head && getVal(dequeIdx[tail-1])>=v) tail--;
      dequeIdx[tail++] = i;
      while(dequeIdx[head] < i-2*radius) head++;
      const center = i-radius;
      if(center>=0 && center<n){ result[center] = getVal(dequeIdx[head]); }
    }
    return result;
  }

  function erode1D_horiz(mask, w, h, radius){
    const out = new Float32Array(w*h);
    const buf = new Float32Array(w);
    for(let y=0; y<h; y++){
      const off = y*w;
      for(let x=0; x<w; x++) buf[x] = mask[off+x];
      const m = slidingMin(buf, w, radius);
      for(let x=0; x<w; x++) out[off+x] = m[x];
    }
    return out;
  }
  function erode1D_vert(mask, w, h, radius){
    const out = new Float32Array(w*h);
    const buf = new Float32Array(h);
    for(let x=0; x<w; x++){
      for(let y=0; y<h; y++) buf[y] = mask[y*w+x];
      const m = slidingMin(buf, h, radius);
      for(let y=0; y<h; y++) out[y*w+x] = m[y];
    }
    return out;
  }
  function erode1D_diag(mask, w, h, radius, sign){
    const out = new Float32Array(w*h).fill(255);
    if(sign>0){ // '\' diagonals, constant x-y
      for(let d=-(h-1); d<=w-1; d++){
        const xStart=Math.max(0,d), xEnd=Math.min(w-1,d+h-1);
        const len=xEnd-xStart+1; if(len<=0) continue;
        const buf=new Float32Array(len);
        for(let i=0;i<len;i++){ const x=xStart+i,y=x-d; buf[i]=mask[y*w+x]; }
        const m=slidingMin(buf,len,radius);
        for(let i=0;i<len;i++){ const x=xStart+i,y=x-d; out[y*w+x]=m[i]; }
      }
    } else { // '/' diagonals, constant x+y
      for(let s=0;s<=w+h-2;s++){
        const xStart=Math.max(0,s-h+1), xEnd=Math.min(w-1,s);
        const len=xEnd-xStart+1; if(len<=0) continue;
        const buf=new Float32Array(len);
        for(let i=0;i<len;i++){ const x=xStart+i,y=s-x; buf[i]=mask[y*w+x]; }
        const m=slidingMin(buf,len,radius);
        for(let i=0;i<len;i++){ const x=xStart+i,y=s-x; out[y*w+x]=m[i]; }
      }
    }
    return out;
  }
  // Rounded (disk-like) erosion via 4-direction structuring-element decomposition:
  // erosion by a horizontal line, a vertical line, and both diagonals, combined by
  // taking the minimum at each pixel. This rounds corners and curves the way
  // Photoshop's Contract Selection does, instead of squaring them off the way a
  // plain row-then-column (square) erosion would.
  function erode2D(mask, w, h, radius){
    if(radius<=0) return mask;
    const rDiag = Math.max(1, Math.round(radius/Math.SQRT2));
    const a = erode1D_horiz(mask, w, h, radius);
    const b = erode1D_vert(mask, w, h, radius);
    const c = erode1D_diag(mask, w, h, rDiag, 1);
    const d = erode1D_diag(mask, w, h, rDiag, -1);
    const out = new Float32Array(w*h);
    for(let i=0;i<w*h;i++) out[i] = Math.min(a[i], b[i], c[i], d[i]);
    return out;
  }

  

  // ---------- pre-export: transparent pixel cleanup ----------
  // Zeroes out any pixel whose alpha is faint-but-nonzero (invisible noise
  // left behind by sloppy background removal) directly on each item's own
  // source art, so it's fixed for good — not just papered over at export
  // time. Items that share the same source image (duplicates, Auto Fill
  // copies) are only processed once and share the cleaned result.
  function removeTransparentPixelsFromAllItems(){
    const FLOOR = 8;
    const cache = new Map();
    let cleanedPixels = 0, cleanedItems = 0;
    for(const it of items){
      if(cache.has(it.img)){
        it.img = cache.get(it.img);
        continue;
      }
      const w = it.nativeW, h = it.nativeH;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const ctx = off.getContext('2d');
      ctx.drawImage(it.img, 0, 0, w, h);
      const imgData = ctx.getImageData(0,0,w,h);
      const data = imgData.data;
      let touched = false;
      for(let i=0;i<data.length;i+=4){
        const a = data[i+3];
        if(a>0 && a<=FLOOR){
          data[i]=0; data[i+1]=0; data[i+2]=0; data[i+3]=0;
          cleanedPixels++; touched = true;
        }
      }
      if(touched) ctx.putImageData(imgData,0,0);
      cache.set(it.img, off);
      it.img = off;
      cleanedItems++;
    }
    return {cleanedPixels, cleanedItems};
  }

  // ---------- pre-export gate ----------
  exportBtn.addEventListener('click', ()=>{
    if(!items.length) return;
    preExportOverlay.classList.add('show');
  });

  cancelPreExportBtn.addEventListener('click', ()=>{
    preExportOverlay.classList.remove('show');
  });

  removeTransparentBtn.addEventListener('click', ()=>{
    preExportOverlay.classList.remove('show');
    const {cleanedPixels, cleanedItems} = removeTransparentPixelsFromAllItems();
    render();
    setStatus(cleanedPixels ? `Cleaned ${cleanedPixels} stray pixel(s) across ${cleanedItems} design(s)` : 'No stray transparent pixels found', true);
    runExport();
  });

  alreadyCheckedBtn.addEventListener('click', ()=>{
    preExportOverlay.classList.remove('show');
    runExport();
  });

  // ---------- export ----------
  async function runExport(){
    if(!items.length) return;

    // Sheet width in pixels, used for the export buffer size below. This is
    // just SHEET_WIDTH_IN × SHEET_DPI — both fixed constants — so it's
    // always correct by construction; no runtime check needed here.
    const sheetWpx = Math.round(SHEET_WIDTH_IN*SHEET_DPI);

    // The canvas itself can never be wider than the sheet, but a design
    // placed or resized so it extends past the right edge WILL get silently
    // clipped at export (its overhanging portion just isn't drawn). Catch
    // that here and let the user fix placement before spending time on a
    // real export.
    const overhanging = items.filter(it => it.xIn + it.wIn > SHEET_WIDTH_IN + 0.01);
    if(overhanging.length){
      const names = overhanging.map(it=>it.name).join(', ');
      const proceed = confirm(
        overhanging.length+' design(s) extend past the right edge of the '+SHEET_WIDTH_IN+'in sheet and will be CUT OFF in the export: '+names+
        '.\n\nClick Auto Nest or Center All Designs to fix this automatically, or Cancel to adjust manually.\n\nExport anyway?'
      );
      if(!proceed) return;
    }

    exportBtn.disabled = true;
    setStatus('Building gang sheet…');
    progressFill.style.width='2%';
    exportingTitle.textContent = 'Exporting…';
    exportingSubtext.textContent = 'Building your gang sheet.';
    exportingOverlay.classList.add('show');
    try{
      const contract = +contractSel.value;
      const hardEdges = hardEdgesCheckbox.checked;
      const sheetHpx = Math.round(sheetHeightIn*SHEET_DPI);

      // ---- large-sheet safety check ----------------------------------------
      // The output is ALWAYS sheetWpx (=3660px = 12.2in) wide — that never
      // changes with height. But a very tall sheet needs a huge pixel buffer
      // and browsers get unreliable building it, which can look like a broken
      // or wrong-size export. 180in is the recommended safe ceiling.
      const totalBytes = sheetWpx * sheetHpx * 5;
      const GB = 1024*1024*1024;
      // Hard stop only for the truly impossible case (past ~2GB the browser
      // can't allocate the buffer and TIFF's 32-bit offsets overflow, so the
      // file would be corrupt no matter what).
      if(totalBytes > 2*GB){
        alert(
          'This gang sheet is too tall to export.\n\n' +
          'Sheet size: '+SHEET_WIDTH_IN.toFixed(2)+'in × '+sheetHeightIn.toFixed(1)+'in. '+
          'The width is correct at '+SHEET_WIDTH_IN.toFixed(2)+'in, but a sheet this long can\'t be '+
          'exported as a single valid file.\n\n' +
          'Please keep sheets at 180 inches or less and export longer jobs as separate sheets.'
        );
        throw new Error('sheet too large: '+(totalBytes/GB).toFixed(2)+'GB');
      }
      if(sheetHeightIn > 180){
        const proceed = confirm(
          'Gang sheets over 180 inches long may export a large file and have errors.\n\n' +
          'This sheet is '+sheetHeightIn.toFixed(1)+'in tall (width is correct at '+SHEET_WIDTH_IN.toFixed(2)+'in).\n\n' +
          'Please stay under 180 inches for best results.\n\nExport anyway?'
        );
        if(!proceed){ throw new Error('user cancelled large export'); }
      }
      // ----------------------------------------------------------------------

      const master = new Uint8Array(sheetWpx*sheetHpx*5);
      // initialize: white RGB (irrelevant, alpha=0), transparency=0 (blank), W1=255 (no ink)
      for(let i=0;i<sheetWpx*sheetHpx;i++){
        const o = i*5;
        master[o]=255; master[o+1]=255; master[o+2]=255; master[o+3]=0; master[o+4]=255;
      }

      let done = 0;
      for(const it of items){
        const pxW = Math.max(1, Math.round(it.wIn*SHEET_DPI));
        const pxH = Math.max(1, Math.round(it.hIn*SHEET_DPI));
        const pxX = Math.round(it.xIn*SHEET_DPI);
        const pxY = Math.round(it.yIn*SHEET_DPI);

        const off = document.createElement('canvas');
        off.width = pxW; off.height = pxH;
        const octx = off.getContext('2d');
        octx.clearRect(0,0,pxW,pxH);
        drawItemForExport(it, octx, pxW, pxH);
        const data = octx.getImageData(0,0,pxW,pxH).data;
        const n = pxW*pxH;

        let w1Values; // 0-255, Photoshop convention (0=full ink, 255=no ink), one per pixel at pxW x pxH
        // Pixels this faint (~3% opacity or less) are invisible noise, not a
        // real anti-aliased edge — clip only these so nothing ambiguous
        // reaches the RIP. Real edges ramp through much higher values than
        // this on the way to fully opaque, so this never touches genuine
        // anti-aliasing, only truly negligible stragglers. Applied before
        // erosion too, so W1 stays protected even at 0px contract.
        //
        // Hard Edges (opt-in, off by default): forces every pixel fully
        // opaque or fully transparent at a 50% cutoff instead — trades away
        // real anti-aliasing for zero partial-transparency pixels.
        const NOISE_ALPHA_FLOOR = 8;
        const cleanedAlpha = new Uint8Array(n);
        for(let i=0;i<n;i++){
          const a = data[i*4+3];
          cleanedAlpha[i] = hardEdges ? (a>=128?255:0) : (a<=NOISE_ALPHA_FLOOR?0:a);
        }

        if(it.mode === 'precomputed' && it.w1Canvas){
          // Resample the already-choked W1 channel to this placed size — never re-choke it.
          const w1off = document.createElement('canvas');
          w1off.width = pxW; w1off.height = pxH;
          const w1ctx = w1off.getContext('2d');
          if(it.rotated){
            const preW = pxH, preH = pxW;
            w1ctx.save();
            w1ctx.translate(pxW/2, pxH/2);
            w1ctx.rotate(Math.PI/2);
            w1ctx.drawImage(it.w1Canvas, -preW/2, -preH/2, preW, preH);
            w1ctx.restore();
          } else {
            w1ctx.drawImage(it.w1Canvas, 0,0,pxW,pxH);
          }
          const w1data = w1ctx.getImageData(0,0,pxW,pxH).data;
          w1Values = new Uint8Array(n);
          for(let i=0;i<n;i++) w1Values[i] = w1data[i*4]; // grayscale, R=G=B
        } else {
          const alphaMaskF = new Float32Array(n);
          for(let i=0;i<n;i++) alphaMaskF[i] = cleanedAlpha[i];
          const eroded = erode2D(alphaMaskF, pxW, pxH, contract);
          w1Values = new Uint8Array(n);
          for(let i=0;i<n;i++) w1Values[i] = Math.round((1 - eroded[i]/255)*255);
        }

        for(let ly=0; ly<pxH; ly++){
          const gy = pxY+ly;
          if(gy<0||gy>=sheetHpx) continue;
          for(let lx=0; lx<pxW; lx++){
            const gx = pxX+lx;
            if(gx<0||gx>=sheetWpx) continue;
            const li = ly*pxW+lx, gi = gy*sheetWpx+gx;
            const so = li*4, go = gi*5;
            const a = cleanedAlpha[li];
            if(a===0) continue; // leave sheet background untouched — noise or true transparency
            master[go]   = data[so];
            master[go+1] = data[so+1];
            master[go+2] = data[so+2];
            master[go+3] = a;
            master[go+4] = w1Values[li];
          }
        }
        done++;
        progressFill.style.width = Math.round(done/items.length*90)+'%';
        await new Promise(r=>setTimeout(r,0)); // yield to keep UI responsive
      }

      setStatus('Encoding TIFF…');
      const tiffBuffer = encodeEditableTIFF(master, sheetWpx, sheetHpx);
      const blob = new Blob([tiffBuffer], {type:'image/tiff'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'gang_sheet_12in.tif';
      document.body.appendChild(a); a.click(); a.remove();
      progressFill.style.width='100%';
      setStatus('Gang sheet exported successfully', true);
      exportingTitle.textContent = 'Export complete';
      exportingSubtext.textContent = 'Your gang sheet TIFF has downloaded.';
    }catch(err){
      console.error('Gang sheet export error:', err);
      setStatus('Export failed — check console for details');
      exportingTitle.textContent = 'Export failed';
      exportingSubtext.textContent = 'Check the console for details.';
    }
    exportBtn.disabled = items.length===0;
    setTimeout(()=>exportingOverlay.classList.remove('show'), 900);
  }

  // ---------- sticker mode: cut line export ----------
  exportCutlinesBtn.addEventListener('click', async ()=>{
    const stickerItems = items.filter(it=>it.cutLine);
    if(!stickerItems.length) return;
    exportCutlinesBtn.disabled = true;
    setStatus('Tracing cut lines…');
    try{
      const pathStrings = [];
      for(const it of stickerItems){
        const pxW = Math.max(1, Math.round(it.wIn*SHEET_DPI));
        const pxH = Math.max(1, Math.round(it.hIn*SHEET_DPI));

        const off = document.createElement('canvas');
        off.width = pxW; off.height = pxH;
        const octx = off.getContext('2d');
        octx.clearRect(0,0,pxW,pxH);
        drawItemForExport(it, octx, pxW, pxH);
        const data = octx.getImageData(0,0,pxW,pxH).data;
        const n = pxW*pxH;

        // Binary mask at 50% alpha — a cut line needs one definitive
        // in-or-out decision per pixel, unlike the ink choke which keeps
        // the full continuous gradient.
        const mask = new Uint8Array(n);
        for(let i=0;i<n;i++) mask[i] = data[i*4+3] >= 128 ? 1 : 0;

        const bleedPx = Math.round(bleedIn * SHEET_DPI);
        const dilated = dilateBinary(mask, pxW, pxH, bleedPx);
        const boundary = traceOutline(dilated, pxW, pxH);
        if(boundary.length < 3) continue;
        const simplified = douglasPeucker(boundary, 1.5);

        // convert from this item's local pixel space to sheet inches
        const pts = simplified.map(p => ({
          x: it.xIn + p.x/SHEET_DPI,
          y: it.yIn + p.y/SHEET_DPI
        }));
        const d = 'M ' + pts.map(p=>`${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' L ') + ' Z';
        pathStrings.push(d);
        await new Promise(r=>setTimeout(r,0));
      }

      const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_WIDTH_IN}in" height="${sheetHeightIn.toFixed(2)}in" viewBox="0 0 ${SHEET_WIDTH_IN} ${sheetHeightIn.toFixed(2)}">
${pathStrings.map(d => `  <path d="${d}" fill="none" stroke="#FF00FF" stroke-width="0.01" />`).join('\n')}
</svg>`;

      const blob = new Blob([svg], {type:'image/svg+xml'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'gang_sheet_cutlines.svg';
      document.body.appendChild(a); a.click(); a.remove();
      setStatus('Cut lines exported ('+stickerItems.length+' design(s))', true);
    }catch(err){
      console.error('Cutline export error:', err);
      setStatus('Cut line export failed — check console for details');
    }
    exportCutlinesBtn.disabled = !items.some(it=>it.cutLine);
  });

})();
