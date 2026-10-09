"""Independent byte expectations over the preserved real Rust wire fixture.
No Agent, current disk receipt, or new Rust execution is implied.
"""
from pathlib import Path
import hashlib
import json

BASE = Path(__file__).resolve().parents[2]
WIRE = BASE / 'large-file-segments/text-block-wire.json'
blocks = json.loads(WIRE.read_text())
whole = ''.join(block['text'] for block in blocks).encode('utf-8')
assert len(whole) == blocks[0]['file']['size'] == 262163
assert hashlib.sha256(whole).hexdigest() == blocks[0]['file']['sha256']
for index, block in enumerate(blocks):
    assert block['blockIndex'] == index
    assert block['file'] == blocks[0]['file']
    encoded = block['text'].encode('utf-8')
    assert whole[block['byteStart']:block['byteEnd']] == encoded
    assert len(encoded) == block['byteEnd'] - block['byteStart']
# Literal choices are independent of the new runtime mapping implementation.
cases = [
    {'block': 0, 'localUtf16Start': 0, 'localUtf16End': 1, 'byteStart': 0, 'byteEnd': 3, 'startLine': 1, 'endLine': 1, 'selected': '\ufeff'},
    {'block': 0, 'localUtf16Start': 1, 'localUtf16End': 3, 'byteStart': 3, 'byteEnd': 9, 'startLine': 1, 'endLine': 1, 'selected': '开始'},
    {'block': 0, 'localUtf16Start': 3, 'localUtf16End': 5, 'byteStart': 9, 'byteEnd': 11, 'startLine': 1, 'endLine': 1, 'selected': '\r\n'},
    {'block': 1, 'localUtf16Start': 123, 'localUtf16End': 126, 'byteStart': 131195, 'byteEnd': 131198, 'startLine': 2, 'endLine': 2, 'selected': 'xxx'},
    {'block': 2, 'localUtf16Start': 11, 'localUtf16End': 15, 'byteStart': 262155, 'byteEnd': 262163, 'startLine': 2, 'endLine': 3, 'selected': '中\r\n尾'},
]
for case in cases:
    block = blocks[case['block']]
    text = block['text']
    start, end = case['localUtf16Start'], case['localUtf16End']
    # This existing wire text contains no astral scalars; UTF-16 equals scalar offsets.
    assert all(ord(c) <= 0xffff for c in text)
    assert text[start:end] == case['selected']
    assert block['byteStart'] + len(text[:start].encode()) == case['byteStart']
    assert block['byteStart'] + len(text[:end].encode()) == case['byteEnd']
    assert whole[case['byteStart']:case['byteEnd']].decode() == case['selected']
record = {
    'kind': 'independent real-Rust-wire coordinate oracle',
    'wire': str(WIRE.relative_to(Path.cwd())),
    'wireSha256': hashlib.sha256(WIRE.read_bytes()).hexdigest(),
    'wholeContentSha256': hashlib.sha256(whole).hexdigest(),
    'wholeBytes': len(whole),
    'blocks': len(blocks),
    'cases': cases,
    'invalidEndpoints': [{'block': 0, 'localUtf16': 4, 'reason': 'inside CRLF'}],
    'result': 'five literal byte-slice assertions passed; three real wire blocks reconstruct exact whole content hash',
    'boundary': 'Existing Rust fixture output is reused; no new Rust run or original temp-file current identity check. Frontend runtime and browser assertions await source freeze. Emoji/combining half-surrogate expectations remain separately in coordinate-oracles.json.'
}
print(json.dumps(record, ensure_ascii=False, indent=2))
