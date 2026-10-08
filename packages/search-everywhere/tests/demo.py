"""Bounded replay of timestamped native PTY output, never widget reconstruction."""
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

FPS = 8
MAX_FRAMES = 240
MAX_ANSI = 16 * 1024 * 1024
MAX_MP4 = 32 * 1024 * 1024
MAX_GIF = 5 * 1024 * 1024
GIF_WIDTH = 990
START = '<!-- demo-video:start -->'
END = '<!-- demo-video:end -->'


class Blocked(RuntimeError):
    pass


def dependencies():
    try:
        import pyte
        from PIL import Image, ImageDraw, ImageFont
        import imageio_ffmpeg
    except ImportError as error:
        raise Blocked('Install tests/requirements-demo.txt in a local venv.') from error
    return pyte, Image, ImageDraw, ImageFont, imageio_ffmpeg.get_ffmpeg_exe()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def recording(base):
    raw = (base / 'terminal.ansi').read_bytes()
    if len(raw) > MAX_ANSI:
        raise ValueError('ANSI cap exceeded')
    rows = [json.loads(line) for line in (base / 'recording.jsonl').read_text().splitlines()]
    last_time = -1; offset = 0
    for row in rows:
        if not isinstance(row['time'], (int, float)) or not 0 <= row['time'] < 300 or row['time'] < last_time:
            raise ValueError('Invalid recording clock')
        if row['type'] == 'chunk':
            if row['start'] != offset or not offset < row['offset'] <= len(raw):
                raise ValueError('Invalid chunk offsets')
            offset = row['offset']
        elif row['offset'] != offset:
            raise ValueError('Invalid event offset')
        if row['type'] == 'resize' and not (1 <= row['rows'] <= 100 and 1 <= row['columns'] <= 200):
            raise ValueError('Invalid terminal size')
        if row['type'] not in ('chunk', 'phase', 'resize'):
            raise ValueError('Unknown recording event')
        last_time = row['time']
    if offset != len(raw):
        raise ValueError('Incomplete recording')
    return raw, rows


COLORS = dict(black='000000', red='cd0000', green='00cd00', brown='cdcd00', blue='0000ee', magenta='cd00cd', cyan='00cdcd', white='e5e5e5', brightblack='7f7f7f', brightred='ff0000', brightgreen='00ff00', brightbrown='ffff00', brightblue='5c5cff', brightmagenta='ff00ff', brightcyan='00ffff', brightwhite='ffffff')


def rgb(value, default):
    color = default if value == 'default' else COLORS.get(value, value)
    if not re.fullmatch('[0-9a-fA-F]{6}', color):
        raise ValueError('Unknown ANSI color: ' + value)
    return '#' + color


def pua(char):
    return 0xe000 <= ord(char) <= 0xf8ff or 0xf0000 <= ord(char) <= 0x10fffd


class Renderer:
    def __init__(self):
        self.pyte, self.Image, self.Draw, self.Font, self.ffmpeg = dependencies()
        paths = [Path(os.environ.get('DEMO_FONT_REGULAR', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf')),
                 Path(os.environ.get('DEMO_FONT_BOLD', '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf')),
                 Path(os.environ.get('DEMO_FONT_ICONS', str(Path.home() / '.local/share/fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf')))]
        if not all(path.is_file() for path in paths):
            raise Blocked('Known regular/bold/Nerd font missing; set DEMO_FONT_REGULAR/BOLD/ICONS.')
        self.fonts = [self.Font.truetype(str(path), 18) for path in paths[:2]]
        self.icon_path = paths[2]; self.icons = {}; self.proof = {}
        self.font_info = [{'path': str(path), 'sha256': sha(path)} for path in paths]

    def icon(self, char):
        if char not in self.icons:
            for size in range(18, 0, -1):
                font = self.Font.truetype(str(self.icon_path), size); box = font.getbbox(char)
                if box[2]-box[0] <= 11 and box[3]-box[1] <= 24:
                    break
            mask = font.getmask(char); missing = font.getmask(chr(0x10ffff))
            if not mask.getbbox() or (mask.size, bytes(mask)) == (missing.size, bytes(missing)):
                raise ValueError(f'Nerd font lacks U+{ord(char):04X}')
            self.icons[char] = font
            self.proof[f'U+{ord(char):04X}'] = dict(size=size, bbox=box, mask_sha256=hashlib.sha256(bytes(mask)).hexdigest(), notdef_different=True)
        return self.icons[char]

    def image(self, screen):
        from wcwidth import wcswidth
        image = self.Image.new('RGB', (1430, 864), 'black')
        for y in range(screen.lines):
            for x in range(screen.columns):
                cell = screen.buffer[y][x]
                if cell.data == '':  # wide-cell continuation is drawn with its lead cell
                    continue
                width = max(1, wcswidth(cell.data))
                fg, bg = rgb(cell.fg, 'e5e5e5'), rgb(cell.bg, '000000')
                if cell.reverse: fg, bg = bg, fg
                tile = self.Image.new('RGB', (11*width, 24), bg); draw = self.Draw.Draw(tile)
                if cell.data.strip():
                    if any(pua(c) for c in cell.data):
                        if len(cell.data) != 1: raise ValueError('Combined PUA cell unsupported')
                        font = self.icon(cell.data); b = font.getbbox(cell.data)
                        pos = ((11-(b[2]-b[0]))//2-b[0], (24-(b[3]-b[1]))//2-b[1])
                    else:
                        font = self.fonts[bool(cell.bold)]; pos = (0, 1)
                    draw.text(pos, cell.data, font=font, fill=fg)
                if cell.underscore: draw.line((0,22,11*width-1,22), fill=fg)
                image.paste(tile, (11*x,24*y))
        return image


def theme_color(data, key):
    if isinstance(data, str): data = json.loads(data)
    section, field = key.split('.')
    value = data[section][field]
    if isinstance(value, list): return ''.join(f'{v:02x}' for v in value)
    # Fresh 0.5.2 theme roles: White emits indexed 15, Gray indexed 7.
    # Native raw-widget probe confirms both with bold on/off; bold changes
    # weight, not this color. Keep the ANSI decoder's SGR 37 palette intact.
    names = {'Yellow':'brown','Blue':'blue','Cyan':'cyan','White':'brightwhite','Black':'black','DarkGray':'brightblack','Gray':'white','Red':'red','Green':'green','Magenta':'magenta','Default':'default'}
    resolved=names.get(value,value.lower())
    return COLORS.get(resolved,resolved)


def cell_proof(screen, name, theme):
    text = '\n'.join(screen.display)
    if 'CUSTOM' in text or 'Kotlin' not in text: raise ValueError('Native caption/title evidence missing')
    is_regex = name == 'full nonliteral callback override'
    expected = 'class Bar { val needle' if is_regex else 'class Foo { fun findUser()'
    line = next(((y, row.rfind(expected)) for y,row in enumerate(screen.display) if row.rfind(expected) > 35), None)
    if line is None: raise ValueError('Actual native source pane absent')
    y,x = line; cells = [screen.buffer[y][c] for c in range(x,x+len(expected))]
    if len({c.fg for c in cells if c.data.strip()}) < 2: raise ValueError('Native grammar foreground absent')
    match = theme_color(theme,'search.match_bg')
    hits = [dict(row=y,col=x,text=c.data,fg=c.fg,bg=c.bg,bold=c.bold)
            for y,row in screen.buffer.items() for x,c in row.items() if c.bg == match]
    if not hits or not all(c['bold'] for c in hits): raise ValueError('Theme match background/bold absent')
    if not any(c['col'] > 35 for c in hits) or not any(c['col'] < 35 for c in hits):
        raise ValueError('Native and snippet matches required')
    # Narrow production rows show basename:line; directory context is omitted.
    titles = ['Bar.kt:1','Foo.kt:1'] if is_regex else ['Foo.kt:1','generated']
    if not all(title in text for title in titles): raise ValueError('Basename:line evidence absent')
    if not is_regex:
        rows=[row[:35] for row in screen.display if row.startswith(('>  ','   '))]
        if len(rows)!=3 or not all('Foo.kt:1' in row for row in rows):
            raise ValueError('Three actual completed picker identities required')
    if is_regex and 'Bar.kt (preview)' not in text: raise ValueError('Native preview tab absent')
    return dict(phase=name, hits=hits, native_cells=[dict(text=c.data,fg=c.fg,bg=c.bg,bold=c.bold) for c in cells])


def pulse_cells(screen):
    from wcwidth import wcswidth
    matches=[]
    for y,row in enumerate(screen.display):
        found=re.search(r'Results · \d+ · Searching ([•·]{3})',row)
        if found: matches.append((y,found.start(1),found.group(1)))
    if not matches: return None
    if len(matches)!=1: raise ValueError('Single Results pulse required')
    y,x,chars=matches[0]
    if chars not in ('•··','·•·','··•') or wcswidth(chars)!=3: raise ValueError('Three-cell pulse required')
    return dict(position=[y,x],chars=chars,width=3,crop=[x*11,y*24,(x+3)*11,(y+1)*24])


def spinner_proof(screen, renderer, base, name):
    proof=pulse_cells(screen)
    if proof is None: raise ValueError('Native Results pulse absent')
    for char in '•·':
        mask=renderer.fonts[0].getmask(char);missing=renderer.fonts[0].getmask(chr(0x10ffff))
        if not mask.getbbox() or (mask.size,bytes(mask))==(missing.size,bytes(missing)):
            raise ValueError('Pulse font coverage absent')
    image=renderer.image(screen);image.save(base/(name+'.png'))
    proof['png_sha256']=sha(base/(name+'.png'));proof['glyph_notdef_different']=True
    return proof


def dot_position(image):
    # Measure foreground area against each cell's own border background, not hash noise.
    scores=[]
    for i in range(3):
        tile=image.crop((round(i*image.width/3),0,round((i+1)*image.width/3),image.height))
        bg=tile.getpixel((0,0))
        scores.append(sum(max(abs(p[c]-bg[c]) for c in range(3)) > 45 for p in tile.getdata()))
    order=sorted(scores,reverse=True)
    if order[0]<4 or order[0]<max(1,order[1])*1.3: raise ValueError('Decoded dense dot not distinguishable')
    return scores.index(max(scores)),scores


def encoded_motion(base, ffmpeg, samples):
    from PIL import Image
    if not samples: raise ValueError('No source pulse samples')
    if len({tuple(s['crop']) for s in samples})!=1: raise ValueError('Pulse geometry jitter')
    crop=samples[0]['crop'];x,y,right,bottom=crop;w,h=right-x,bottom-y
    raw=invoke([ffmpeg,'-v','error','-i',str(base/'demo.mp4'),'-vf',f'crop={w}:{h}:{x}:{y}:exact=1','-f','rawvideo','-pix_fmt','rgb24','-']).stdout
    proofs={'mp4':[],'gif':[]}
    for sample in samples:
        n=sample['source_frame_index'];tile=Image.frombytes('RGB',(w,h),raw[n*w*h*3:(n+1)*w*h*3])
        pos,scores=dot_position(tile)
        if pos!=sample['chars'].index('•'): raise ValueError('MP4 dot differs from source')
        proofs['mp4'].append(dict(sample,decoded_position=pos,foreground_pixels=scores))
    with Image.open(base/'demo.gif') as gif:
        elapsed=0;scaled=[round(x*gif.width/1430),round(y*gif.height/864),round(right*gif.width/1430),round(bottom*gif.height/864)]
        for n in range(gif.n_frames):
            gif.seek(n);duration=gif.info.get('duration',0)/1000
            source_index=round(elapsed*FPS);sample=next((s for s in samples if s['source_frame_index']==source_index),None)
            if sample:
                pos,scores=dot_position(gif.convert('RGB').crop(scaled))
                if pos!=sample['chars'].index('•'): raise ValueError('GIF dot differs from source')
                proofs['gif'].append(dict(sample,decoded_frame_index=n,decoded_time=elapsed,crop=scaled,decoded_position=pos,foreground_pixels=scores))
            elapsed+=duration
    for kind,rows in proofs.items():
        groups=[]
        for row in rows:
            if not groups or row['source_frame_index']!=groups[-1][-1]['source_frame_index']+1 or row['recording_time']-groups[-1][-1]['recording_time']>1.5/FPS:
                groups.append([])
            groups[-1].append(row)
        if not any(len({r['decoded_position'] for r in group})>=3 and (group[-1]['source_frame_index']-group[0]['source_frame_index'])/FPS>=1.5 for group in groups):
            raise ValueError(kind+' needs three decoded positions over at least 1.5 contiguous seconds')
    return proofs


def encoded_stability(base, ffmpeg, samples):
    """Compare fixed-theme native pending frames with both final decoded assets."""
    from PIL import Image, ImageChops, ImageStat, ImageDraw
    groups=[]
    for sample in samples:
        if not groups or sample['source_frame_index']!=groups[-1][-1]['source_frame_index']+1 or sample['outside_pulse_sha256']!=groups[-1][-1]['outside_pulse_sha256']:
            groups.append([])
        groups[-1].append(sample)
    stable=max(groups,key=len,default=[])
    if not stable or (stable[-1]['source_frame_index']-stable[0]['source_frame_index'])/FPS<1.5:
        raise ValueError('First-search native pending scene needs 1.5 seconds stable outside pulse')
    result={'native_stable_seconds':(stable[-1]['source_frame_index']-stable[0]['source_frame_index'])/FPS,
            'native_stable_frames':[s['source_frame_index'] for s in stable], 'gif':[], 'mp4':[]}
    def difference(a,b,crop):
        delta=ImageChops.difference(a,b)
        # Lanczos/H264 can affect pixels surrounding the three pulse cells.
        x,y,r,bottom=crop;ImageDraw.Draw(delta).rectangle((max(0,x-4),max(0,y-4),r+4,bottom+4),fill=(0,0,0))
        return dict(mean_channel_delta=sum(ImageStat.Stat(delta).mean)/3,
                    max_channel_delta=max(v[1] for v in delta.getextrema()),
                    changed_pixels=sum(pixel!=(0,0,0) for pixel in delta.getdata()))
    with tempfile.TemporaryDirectory(prefix='decoded-stability-',dir=base) as temp:
        invoke([ffmpeg,'-v','error','-i',str(base/'demo.mp4'),str(Path(temp)/'%04d.png')])
        previous=None
        for s in stable:
            n=s['source_frame_index'];image=Image.open(Path(temp)/f'{n+1:04d}.png').convert('RGB')
            if previous is not None:
                proof=difference(previous,image,s['crop']);result['mp4'].append(dict(frame=n,**proof))
                if proof['mean_channel_delta']>.05 or proof['max_channel_delta']>64:
                    raise ValueError('MP4 stable pending scene exceeds codec-noise bounds: '+str(proof))
            previous=image
    with Image.open(base/'demo.gif') as gif:
        elapsed=0;previous=None;indices={s['source_frame_index']:s for s in stable}
        for n in range(gif.n_frames):
            gif.seek(n);index=round(elapsed*FPS);sample=indices.get(index)
            if sample:
                image=gif.convert('RGB');crop=[round(v*gif.width/1430) if i%2==0 else round(v*gif.height/864) for i,v in enumerate(sample['crop'])]
                if previous is not None:
                    proof=difference(previous,image,crop);result['gif'].append(dict(frame=n,source_frame=index,**proof))
                    if proof['changed_pixels']:
                        raise ValueError('GIF fixed pending scene changes outside pulse: '+str(proof))
                previous=image
            elapsed+=gif.info.get('duration',0)/1000
    if not result['gif'] or not result['mp4']:raise ValueError('Encoded stability evidence absent')
    return result


def invoke(command, timeout=60):
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stderr.decode(errors='replace')[-3000:])
    return result


def verify_gif(path, duration):
    from PIL import Image
    if not 0 < path.stat().st_size <= MAX_GIF: raise ValueError('GIF size cap exceeded')
    with Image.open(path) as image:
        if image.format != 'GIF' or not image.is_animated or not 2 <= image.n_frames <= MAX_FRAMES:
            raise ValueError('Animated GIF frame cap/format mismatch')
        width,height = image.size
        if width != GIF_WIDTH or abs(width/height - 1430/864) > .01:
            raise ValueError('GIF dimensions/aspect mismatch')
        elapsed = 0
        for i in range(image.n_frames):
            image.seek(i); image.load(); elapsed += image.info.get('duration',0)
        if elapsed <= 0 or elapsed > 30000 or abs(elapsed/1000-duration) > .15:
            raise ValueError('GIF duration mismatch')
        return dict(frames=image.n_frames, dimensions=[width,height], duration=elapsed/1000,
                    bytes=path.stat().st_size, sha256=sha(path), full_decode='PASS')


def make_gif(base, ffmpeg, duration, frames):
    target = base/'demo.gif'
    filters = f'fps={FPS},scale={GIF_WIDTH}:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle'
    # Use the same lossless PTY replay frames, not H264 quantization noise.
    invoke([ffmpeg,'-hide_banner','-loglevel','error','-y','-framerate',str(FPS),'-i',str(frames/'%04d.png'),
            '-filter_complex',filters,'-loop','0','-threads','2',str(target)])
    return verify_gif(target,duration)


def make(base, source, source_files):
    raw, events = recording(base)
    renderer = Renderer()
    phases = {e['name']: e for e in events if e['type'] == 'phase'}
    clips = []
    for start, end in [('demo-foo-start','demo-foo-end'), ('demo-regex-start','demo-regex-end')]:
        a, b = phases[start]['time'], phases[end]['time']
        if b <= a: raise ValueError('Empty demo clip')
        clips.append(dict(start=a, end=b, phases=[start,end]))
    times = [clip['start'] + i/FPS for clip in clips for i in range(int((clip['end']-clip['start'])*FPS)+1)]
    if not times or len(times) > MAX_FRAMES: raise ValueError('Frame/duration cap exceeded')
    native_sources = json.loads((base/'native-source-manifest.json').read_text())
    production = {name: sha(source/name) for name in source_files if name.endswith('.ts') and '/tests/' not in name}
    if len(production) != 8 or production != {name: row['source_sha256'] for name,row in native_sources.items()}:
        raise ValueError('Exact eight-production-file native provenance mismatch')
    if any(row['copy_sha256'] != row['source_sha256'] for row in native_sources.values() if not row['instrumented']):
        raise ValueError('Uninstrumented native source copy mismatch')
    screen = renderer.pyte.Screen(130,36); stream = renderer.pyte.ByteStream(screen)
    index = 0; proofs = []; spinner = []; samples = []; theme_proofs=[]
    theme_rows={(row['state'],row['name']):row for row in json.loads((base/'theme-evidence.json').read_text())}
    theme=json.loads((base/'theme-meta.json').read_text())['data']
    # Replay every skipped byte and resize before the next selected frame.
    with tempfile.TemporaryDirectory(prefix='demo-frames-', dir=base) as temp:
        for number, timestamp in enumerate(times):
            while index < len(events) and events[index]['time'] <= timestamp:
                event = events[index]
                if event['type'] == 'chunk': stream.feed(raw[event['start']:event['offset']])
                elif event['type'] == 'resize': screen.resize(lines=event['rows'], columns=event['columns'])
                elif event['type'] == 'phase' and event['name'] in ('native bind; live files and fake LSP', 'full nonliteral callback override'):
                    proofs.append(cell_proof(screen,event['name'],theme))
                    renderer.image(screen).save(base/('demo-foo-proof.png' if event['name'].startswith('native bind') else 'demo-regex-proof.png'))
                if event['type']=='phase' and event['name'].startswith('theme-'):
                    _,state,name=event['name'].split('-',2);meta=theme_rows[state,name]['data']
                    title=next(((y,row.index('Results · ')) for y,row in enumerate(screen.display) if 'Results · ' in row),None)
                    if title is None: raise ValueError('Native theme widget absent')
                    y,x=title;actual=screen.buffer[y][x].fg;expected=theme_color(meta,'ui.help_key_fg')
                    if actual!=expected: raise ValueError(f'Idle/pending widget theme mismatch: {name} {actual} != {expected}')
                    match=theme_color(meta,'search.match_bg');native_hits=[(y,x) for y,row in screen.buffer.items() for x,c in row.items() if x>35 and c.bg==match]
                    if not native_hits: raise ValueError('Native source overlay did not retheme')
                    native_fg=theme_color(meta,'syntax.type')
                    if any(screen.buffer[y][x].fg!=native_fg for y,x in native_hits): raise ValueError('Native query overlay replaced syntax foreground')
                    selected=next(((y,row.index('> ')) for y,row in enumerate(screen.display) if '> ' in row and 'Foo.kt:1' in row),None)
                    if selected is None: raise ValueError('Selected row theme evidence absent')
                    sy,sx=selected;selected_cell=screen.buffer[sy][sx]
                    if selected_cell.fg!=theme_color(meta,'ui.popup_selection_fg') or selected_cell.bg!=theme_color(meta,'ui.popup_selection_bg'):
                        raise ValueError('Selected row theme foreground/background mismatch')
                    foreign=[(y,x) for y,row in screen.buffer.items() for x,c in row.items() if c.bg=='c800b4']
                    if not foreign: raise ValueError('Foreign overlay lost on theme change')
                    pulse=pulse_cells(screen)
                    if (state=='pending') != bool(pulse): raise ValueError('Native theme pending/idle pulse mismatch')
                    theme_proofs.append(dict(state=state,name=name,widget_fg=actual,expected_fg=expected,native_match_bg=match,native_hits=native_hits,native_syntax_fg=native_fg,selected_fg=selected_cell.fg,selected_bg=selected_cell.bg,foreign_cells=foreign,providerCallsUnchanged=True))
                if event['type'] == 'phase' and event['name'] in ('demo-spinner-a','demo-spinner-b'):
                    spinner.append(spinner_proof(screen, renderer, base, event['name']))
                index += 1
            pulse=pulse_cells(screen)
            if pulse:
                y,x=pulse['position']
                stable_cells=[(yy,xx,c.data,c.fg,c.bg,c.bold,c.reverse,c.underscore) for yy in range(screen.lines) for xx in range(screen.columns)
                              if not (yy==y and x<=xx<x+3) for c in [screen.buffer[yy][xx]]]
                samples.append(dict(pulse,source_frame_index=number,recording_time=timestamp,
                    outside_pulse_sha256=hashlib.sha256(json.dumps(stable_cells).encode()).hexdigest()))
            image = renderer.image(screen)
            image.save(Path(temp) / f'{number:04d}.png')
        # PNG is a lossless proof from the same terminal replay, not ui.json.
        image.save(base / 'demo-proof.png')
        if len(spinner) != 2 or spinner[0]['chars'] == spinner[1]['chars'] or spinner[0]['position'] != spinner[1]['position']:
            raise ValueError('Two distinct fixed-cell native spinner frames required')
        if len(proofs) != 2: raise ValueError('Required demo phases not replayed')
        target = base / 'demo.mp4'
        invoke([renderer.ffmpeg, '-hide_banner','-loglevel','error','-y','-framerate',str(FPS),'-i',str(Path(temp)/'%04d.png'),'-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-threads','2',str(target)])
        gif = make_gif(base, renderer.ffmpeg, len(times)/FPS, Path(temp))
        stability=encoded_stability(base,renderer.ffmpeg,[s for s in samples if clips[0]['start']<=s['recording_time']<=clips[0]['end']])
    if not 0 < target.stat().st_size <= MAX_MP4: raise ValueError('MP4 size cap exceeded')
    # Full bounded decode and observed metadata; no dependency on ffprobe.
    decoded = invoke([renderer.ffmpeg,'-hide_banner','-i',str(target),'-progress','pipe:1','-f','null','-'])
    meta = decoded.stderr.decode(errors='replace'); progress = decoded.stdout.decode()
    frames = re.findall(r'^frame=(\d+)$', progress, re.M)
    if not frames or int(frames[-1]) != len(times) or 'yuv420p' not in meta or '1430x864' not in meta or '8 fps' not in meta or 'Video: h264' not in meta:
        raise ValueError('Decoded video metadata/frame count mismatch')
    decoded_times = re.findall(r'^out_time_us=(\d+)$', progress, re.M)
    if not decoded_times or abs(int(decoded_times[-1])/1_000_000 - len(times)/FPS) > 1/FPS:
        raise ValueError('Decoded duration mismatch')
    motion=encoded_motion(base,renderer.ffmpeg,samples)
    manifest = dict(encoded_motion=motion, encoded_stability=stability, theme_evidence=theme_proofs, theme=theme, gif=gif, gif_sha256=gif['sha256'], mp4_bytes=target.stat().st_size,
                    phase_pngs={name: sha(base/name) for name in ('demo-foo-proof.png','demo-regex-proof.png')},
                    decoded_duration=int(decoded_times[-1])/1_000_000, ansi_sha256=sha(base/'terminal.ansi'), recording_sha256=sha(base/'recording.jsonl'),
                    mp4_sha256=sha(target), png_sha256=sha(base/'demo-proof.png'), frames=len(times), fps=FPS,
                    duration=len(times)/FPS, dimensions=[1430,864], codec='h264', pixel_format='yuv420p',
                    clips=clips, caps=dict(frames=MAX_FRAMES, seconds=30, ansi_bytes=MAX_ANSI, mp4_bytes=MAX_MP4, gif_bytes=MAX_GIF),
                    fonts=renderer.font_info, glyphs=renderer.proof, highlight_cells=proofs, spinner_cells=spinner,
                    source_hashes={name: sha(source/name) for name in source_files}, native_sources=native_sources, production_files=8,
                    tools={name: importlib.metadata.version(name) for name in ('pyte','Pillow','wcwidth','imageio-ffmpeg')},
                    ffmpeg_version=invoke([renderer.ffmpeg,'-version']).stdout.decode().splitlines()[0], decode_metadata=meta,
                    caption='Actual native Fresh PTY; fake Kotlin LSP and custom file/content fixture providers. Not real backend acceptance.')
    (base/'demo-manifest.json').write_text(json.dumps(manifest, indent=2)+'\n')
    return manifest


def readme_snapshot(path):
    path = Path(path)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('README symlink rejected')
    data = path.read_bytes(); text = data.decode()
    if text.count(START) != 1 or text.count(END) != 1 or text.index(START) >= text.index(END):
        raise ValueError('Unique ordered demo markers required')
    return data


def replace_readme(path, original):
    if readme_snapshot(path) != original: raise ValueError('README changed concurrently')
    text = original.decode(); a = text.index(START)+len(START); b = text.index(END)
    block = '\n[![Plugin demo](assets/demo.gif)](assets/demo.mp4)\n'
    fd, temp = tempfile.mkstemp(prefix='.demo-readme-', dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write((text[:a]+block+text[b:]).encode())
        os.chmod(temp, path.stat().st_mode & 0o777)
        if readme_snapshot(path) != original: raise ValueError('README changed concurrently')
        os.replace(temp,path)
    finally:
        if os.path.exists(temp): os.unlink(temp)


def asset_snapshot(path):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('Asset symlink rejected')
    if path.exists() and not path.is_file(): raise ValueError('Asset must be a regular file')
    return path.read_bytes() if path.exists() else None


def stage_asset(path, data):
    asset_snapshot(path)  # Recheck symlink boundaries immediately before staging.
    fd, temp = tempfile.mkstemp(prefix='.demo-asset-', dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write(data)
        os.chmod(temp,0o644)
        return Path(temp)
    except Exception:
        os.unlink(temp)
        raise


def atomic_asset(path, data):
    temp = stage_asset(path,data)
    try: os.replace(temp,path)
    finally:
        if temp.exists(): temp.unlink()


def publish(base, readme, original, source_root=None, source_files=None):
    if readme_snapshot(readme) != original: raise ValueError('README changed concurrently')
    manifest = json.loads((base/'demo-manifest.json').read_text())
    if source_root is not None:
        expected = {name: sha(source_root/name) for name in source_files}
        if expected != manifest['source_hashes']:
            raise ValueError('Source changed since native capture')
    assets = readme.parent/'assets'
    if assets.is_symlink() or any(parent.is_symlink() for parent in assets.parents):
        raise ValueError('Asset directory symlink rejected')
    if assets.exists() and not assets.is_dir(): raise ValueError('Assets directory required')
    targets = [assets/'demo.gif', assets/'demo.mp4']
    old = [asset_snapshot(path) for path in targets]
    data = [(base/path.name).read_bytes() for path in targets]
    for path, content, cap in zip(targets,data,[MAX_GIF,MAX_MP4]):
        if not 0 < len(content) <= cap or hashlib.sha256(content).hexdigest() != manifest[path.suffix[1:]+'_sha256']:
            raise ValueError('Verified asset hash/size mismatch')
    assets.mkdir(exist_ok=True)
    changed = []; staged = []
    try:
        for path, content in zip(targets,data): staged.append(stage_asset(path,content))
        for path, temp in zip(targets,staged):
            if asset_snapshot(path) != old[targets.index(path)]:
                raise ValueError('Asset changed concurrently')
            os.replace(temp,path); changed.append(path)
        # README is the last operation that can fail on the successful path.
        replace_readme(readme,original)
    except Exception:
        for temp in staged:
            if temp.exists(): temp.unlink()
        for path in reversed(changed):
            if asset_snapshot(path) != data[targets.index(path)]:
                continue  # Never roll back an independent writer's replacement.
            previous = old[targets.index(path)]
            if previous is None: path.unlink()
            else: atomic_asset(path,previous)
        raise
    return 'assets/demo.gif + assets/demo.mp4'
