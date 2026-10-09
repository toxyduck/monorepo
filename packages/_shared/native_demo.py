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
MAX_FRAMES = 480  # 60 seconds, including presentation holds; byte caps stay unchanged.
HOLD_SECONDS = 1.5
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
        if elapsed <= 0 or elapsed > MAX_FRAMES/FPS*1000 or abs(elapsed/1000-duration) > .15:
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


def readme_snapshot(path):
    path = Path(path)
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents):
        raise ValueError('README symlink rejected')
    data = path.read_bytes(); text = data.decode()
    if text.count(START) != 1 or text.count(END) != 1 or text.index(START) >= text.index(END):
        raise ValueError('Unique ordered demo markers required')
    return data


def replace_readme(path, original, block=None):
    if readme_snapshot(path) != original: raise ValueError('README changed concurrently')
    text = original.decode(); a = text.index(START)+len(START); b = text.index(END)
    block = block if block is not None else '\n[![Plugin demo](assets/demo.gif)](assets/demo.mp4)\n'
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


def publish(base, readme, original, source_root=None, source_files=None, asset_dir=None, readme_block=None, provenance=False):
    if readme_snapshot(readme) != original: raise ValueError('README changed concurrently')
    manifest = json.loads((base/'demo-manifest.json').read_text())
    if source_root is not None:
        expected = {name: sha(source_root/name) for name in source_files}
        if expected != manifest['source_hashes']:
            raise ValueError('Source changed since native capture')
    assets = asset_dir if asset_dir is not None else readme.parent/'assets'
    if assets.is_symlink() or any(parent.is_symlink() for parent in assets.parents):
        raise ValueError('Asset directory symlink rejected')
    if assets.exists() and not assets.is_dir(): raise ValueError('Assets directory required')
    targets = [assets/'demo.gif', assets/'demo.mp4']
    old = [asset_snapshot(path) for path in targets]
    data = [(base/path.name).read_bytes() for path in targets]
    for path, content, cap in zip(targets,data,[MAX_GIF,MAX_MP4]):
        if not 0 < len(content) <= cap or hashlib.sha256(content).hexdigest() != manifest[path.suffix[1:]+'_sha256']:
            raise ValueError('Verified asset hash/size mismatch')
    if provenance:
        targets.append(assets/'provenance.json')
        old.append(asset_snapshot(targets[-1]))
        data.append((base/'demo-manifest.json').read_bytes())
    assets.mkdir(exist_ok=True)
    changed = []; staged = []
    try:
        for path, content in zip(targets,data): staged.append(stage_asset(path,content))
        for path, temp in zip(targets,staged):
            if asset_snapshot(path) != old[targets.index(path)]:
                raise ValueError('Asset changed concurrently')
            os.replace(temp,path); changed.append(path)
        # README is the last operation that can fail on the successful path.
        replace_readme(readme,original,readme_block)
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


def isolated_env(base):
    env = os.environ.copy()
    for key in list(env):
        if key.startswith('FRESH_') or key in ('NODE_OPTIONS','NODE_PATH','PYTHONSTARTUP','PYTHONPATH','BASH_ENV','ENV','ZDOTDIR','LD_PRELOAD','LD_LIBRARY_PATH'):
            del env[key]
    for key,name in [('HOME','home'),('XDG_CONFIG_HOME','config'),('XDG_DATA_HOME','data'),('XDG_STATE_HOME','state'),('XDG_CACHE_HOME','cache'),('XDG_RUNTIME_DIR','runtime'),('TMPDIR','tmp')]:
        folder=base/name;folder.mkdir(mode=0o700);env[key]=str(folder)
    env['TERM']='xterm-256color';env['COLORTERM']='truecolor'
    return env


def open_pty(rows,columns):
    import pty,fcntl,termios,struct
    master,slave=pty.openpty()
    fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',rows,columns,0,0))
    return master,slave


def launch(binary,file,cwd,env,slave):
    return subprocess.Popen([binary,'--no-upgrade-check','--locale','en',str(file)],cwd=cwd,env=env,stdin=slave,stdout=slave,stderr=slave,start_new_session=True)


def stop_process(process):
    import signal
    if process and process.poll() is None:
        try: os.killpg(process.pid,signal.SIGTERM)
        except ProcessLookupError: pass
        try: process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=2)


def record_event(events,clock,offset,kind,**fields):
    import time
    events.append(dict(type=kind,time=time.monotonic()-clock,offset=offset,**fields))


def write_source_copy(source,dest,transform=lambda text:text):
    dest.parent.mkdir(parents=True,exist_ok=True)
    dest.write_text(transform(source.read_text()))
    return dict(source_sha256=sha(source),copy_sha256=sha(dest))


def presentation_timeline(events, clips, hold_phases=(), hold_seconds=HOLD_SECONDS):
    """Sample the PTY clock; freeze exact phase states only on the media clock.

    event_count prevents later events at the same timestamp leaking into a hold.
    No recording timestamps, assertions or process deadlines are changed.
    """
    import bisect
    import math
    if not math.isfinite(hold_seconds) or not 0 <= hold_seconds <= 5:
        raise ValueError('Hold duration must be between 0 and 5 seconds')
    clocks = [e['time'] for e in events]
    samples = []; holds = []
    hold_frames = math.ceil(hold_seconds*FPS)
    for clip in clips:
        start, end = clip['start'], clip['end']
        if end <= start: raise ValueError('Empty demo clip')
        points = [(start+i/FPS, bisect.bisect_right(clocks,start+i/FPS), None)
                  for i in range(math.ceil((end-start)*FPS))]
        # Include the final checkpoint, even when it falls between sampled frames.
        points.append((end, bisect.bisect_right(clocks,end), None))
        for index,e in enumerate(events):
            if e['type']=='phase' and e['name'] in hold_phases and start<=e['time']<=end:
                points.append((e['time'],index+1,e['name']))
        for timestamp, count, phase in sorted(points, key=lambda p:(p[0],p[1],p[2] is None)):
            if phase is not None:
                if hold_frames:
                    holds.append(dict(phase=phase,recording_time=timestamp,event_count=count,
                                      presentation_start=len(samples)/FPS,frames=hold_frames,seconds=hold_frames/FPS))
                    samples.extend([dict(recording_time=timestamp,event_count=count,held=True)]*hold_frames)
            else:
                samples.append(dict(recording_time=timestamp,event_count=count,held=False))
        if len(samples)>MAX_FRAMES: raise ValueError('Frame/duration cap exceeded')
    timing = dict(recording_duration=events[-1]['time'],source_clips=clips,
                  sampled_frames=sum(not s['held'] for s in samples),
                  presentation_duration=len(samples)/FPS,hold_seconds=hold_seconds,holds=holds,
                  policy='Exact semantic phase freezes; PTY timestamps unchanged. Holds are presentation only.')
    return samples, timing


def encode_recording(base, caption, source_hashes, assertions, hold_phases=(), hold_seconds=HOLD_SECONDS):
    # Generic bounded replay; scenario assertions belong to the caller.
    raw,events=recording(base)
    samples,timing=presentation_timeline(events,[dict(start=0,end=events[-1]['time'])],hold_phases,hold_seconds)
    frames=len(samples)
    if not 1<frames<=MAX_FRAMES:raise ValueError('Frame cap exceeded')
    renderer=Renderer();screen=renderer.pyte.Screen(130,36);stream=renderer.pyte.ByteStream(screen)
    index=0
    with tempfile.TemporaryDirectory(prefix='native-frames-',dir=base) as temp:
        for number,sample in enumerate(samples):
            while index<sample['event_count']:
                event=events[index]
                if event['type']=='chunk':stream.feed(raw[event['start']:event['offset']])
                elif event['type']=='resize':screen.resize(lines=event['rows'],columns=event['columns'])
                index+=1
            renderer.image(screen).save(Path(temp)/f'{number:04d}.png')
        invoke([renderer.ffmpeg,'-hide_banner','-loglevel','error','-y','-framerate',str(FPS),'-i',str(Path(temp)/'%04d.png'),'-an','-c:v','libx264','-pix_fmt','yuv420p','-movflags','+faststart','-threads','2',str(base/'demo.mp4')])
        gif=make_gif(base,renderer.ffmpeg,frames/FPS,Path(temp))
    if not 0<(base/'demo.mp4').stat().st_size<=MAX_MP4:raise ValueError('MP4 cap exceeded')
    decoded=invoke([renderer.ffmpeg,'-hide_banner','-i',str(base/'demo.mp4'),'-progress','pipe:1','-f','null','-'])
    counts=re.findall(rb'^frame=(\d+)$',decoded.stdout,re.M)
    if not counts or int(counts[-1])!=frames:raise ValueError('Decode frame mismatch')
    decoded_times=re.findall(rb'^out_time_us=(\d+)$',decoded.stdout,re.M)
    if not decoded_times or abs(int(decoded_times[-1])/1_000_000-frames/FPS)>1/FPS:
        raise ValueError('Decoded duration mismatch')
    (base/'decode.log').write_bytes(decoded.stderr+decoded.stdout)
    manifest=dict(timing=timing,caption=caption,assertions=assertions,source_hashes=source_hashes,recording_sha256=sha(base/'recording.jsonl'),ansi_sha256=sha(base/'terminal.ansi'),gif=gif,gif_sha256=gif['sha256'],mp4_sha256=sha(base/'demo.mp4'),frames=frames,fps=FPS,duration=frames/FPS,full_decode='PASS',fonts=[dict(file=Path(f['path']).name,sha256=f['sha256']) for f in renderer.font_info],tools={name:importlib.metadata.version(name) for name in ('pyte','Pillow','wcwidth','imageio-ffmpeg')},ffmpeg_version=invoke([renderer.ffmpeg,'-version']).stdout.decode().splitlines()[0])
    (base/'demo-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest


def clip_recording(base, dest, start_name, end_name):
    raw,events=recording(base)
    a=next(e for e in events if e['type']=='phase' and e['name']==start_name)
    b=next(e for e in events if e['type']=='phase' and e['name']==end_name)
    if b['time']<=a['time']:raise ValueError('Empty clip')
    dest.mkdir(parents=True,exist_ok=True)
    size=next(e for e in reversed(events) if e['type']=='resize' and e['time']<=a['time'])
    rows=[dict(type='resize',time=0,offset=0,rows=size['rows'],columns=size['columns'])]
    if a['offset']:rows.append(dict(type='chunk',time=0,start=0,offset=a['offset']))
    for e in events:
        if a['time']<=e['time']<=b['time']:
            rows.append(dict(e,time=e['time']-a['time']))
    (dest/'terminal.ansi').write_bytes(raw[:b['offset']])
    (dest/'recording.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
    return dict(source_ansi_sha256=sha(base/'terminal.ansi'),source_recording_sha256=sha(base/'recording.jsonl'),start_phase=start_name,end_phase=end_name)
