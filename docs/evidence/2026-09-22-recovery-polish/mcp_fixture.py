"""Local harmless MCP service. Only multiplication; no network or user-file access."""
import datetime
import json
import os
from pathlib import Path
import secrets
import sys

ROOT = Path(__file__).resolve().parent
for line in sys.stdin:
    request = json.loads(line)
    with (ROOT/'mcp-lifecycle.jsonl').open('a') as lifecycle:
        lifecycle.write(json.dumps({'at': datetime.datetime.now().astimezone().isoformat(), 'pid': os.getpid(), 'method': request.get('method')})+'\n')
    if 'id' not in request:
        continue
    method = request.get('method')
    params = request.get('params', {})
    if method == 'initialize':
        result = {'protocolVersion': params.get('protocolVersion', '2024-11-05'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'farfold-local-arithmetic', 'version': '1.0.0'}}
    elif method == 'tools/list':
        result = {'tools': [{'name': 'multiply', 'description': 'Multiply two integers and return a fresh verification receipt.', 'inputSchema': {'type': 'object', 'properties': {'a': {'type': 'integer'}, 'b': {'type': 'integer'}}, 'required': ['a', 'b'], 'additionalProperties': False}, 'annotations': {'readOnlyHint': True, 'destructiveHint': False, 'openWorldHint': False}}]}
    elif method == 'tools/call' and params.get('name') == 'multiply':
        args = params.get('arguments', {})
        a, b = args.get('a'), args.get('b')
        if type(a) is not int or type(b) is not int:
            result = {'content': [{'type': 'text', 'text': 'integers required'}], 'isError': True}
        else:
            receipt = 'FARFOLD-MCP-'+secrets.token_hex(6)
            result = {'content': [{'type': 'text', 'text': json.dumps({'product': a*b, 'receipt': receipt})}]}
            with (ROOT/'mcp-calls.jsonl').open('a') as output:
                output.write(json.dumps({'at': datetime.datetime.now().astimezone().isoformat(), 'pid': os.getpid(), 'a': a, 'b': b, 'product': a*b, 'receipt': receipt})+'\n')
    elif method in ('resources/list', 'resources/templates/list', 'prompts/list'):
        key = {'resources/list': 'resources', 'resources/templates/list': 'resourceTemplates', 'prompts/list': 'prompts'}[method]
        result = {key: []}
    elif method == 'ping':
        result = {}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'method not found'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
