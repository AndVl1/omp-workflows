from pathlib import Path

files = [
'packages/core/test/cto-specification-execution.test.ts',
'packages/core/test/cto-specification-preparation-entry.test.ts',
'packages/core/test/do-work-specification-routing.test.ts',
'packages/core/test/durable-repeated-role.test.ts',
'packages/core/test/import-handoff-finalizer.test.ts',
'packages/core/test/specification-command.test.ts',
'packages/core/test/specification-conformance-boundaries.test.ts',
'packages/core/test/specification-constitution.test.ts',
'packages/core/test/specification-finalizer.test.ts',
'packages/core/test/workflow-engine-scopes.test.ts',
'packages/core/test/specification-impact-runtime.test.ts',
]

names = ('registerWorkflowTools', 'registerConstitutionTools', 'registerCtoTools')

def matching(s, start, op='{', cl='}'):
    depth=0; quote=None; esc=False
    for i in range(start, len(s)):
        c=s[i]
        if quote:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c==quote: quote=None
            continue
        if c in "'\"`": quote=c; continue
        if c==op: depth+=1
        elif c==cl:
            depth-=1
            if depth==0: return i
    raise ValueError((start, op, cl))

def split_args(body):
    parts=[]; start=0; depth=0; quote=None; esc=False
    for i,c in enumerate(body):
        if quote:
            if esc: esc=False
            elif c=='\\': esc=True
            elif c==quote: quote=None
            continue
        if c in "'\"`": quote=c; continue
        if c in '({[': depth+=1
        elif c in ')}]': depth-=1
        elif c==',' and depth==0:
            parts.append((start,i)); start=i+1
    parts.append((start,len(body)))
    return parts

def migrate(s):
    pos=0; replacements=[]
    while True:
        hits=[s.find(n+'(', pos) for n in names]
        hits=[(h,n) for h,n in zip(hits,names) if h>=0]
        if not hits: break
        start,n=min(hits)
        # skip declaration-like or property access not relevant
        open_at=start+len(n)
        close=matching(s, open_at, '(', ')')
        body=s[open_at+1:close]
        parts=split_args(body)
        if len(parts)==1:
            a=body.strip()
            newbody=body.rstrip()+', { owner: TEST_OWNER }'
        else:
            # only add to second arg; preserve source around args
            a0,b0=parts[1]
            second=body[a0:b0]
            if 'owner:' in second or 'owner :' in second:
                newbody=body
            elif second.strip().startswith('{'):
                lead=second[:len(second)-len(second.lstrip())]
                newsecond=second.replace('{', '{\n      owner: TEST_OWNER,', 1)
                newbody=body[:a0]+newsecond+body[b0:]
            else:
                # Preserve caller-supplied options while supplying the test owner.
                newbody=body[:a0]+'{ ...'+second.strip()+', owner: TEST_OWNER }'+body[b0:]
        replacements.append((open_at+1, close, newbody))
        pos=close+1
    for a,b,v in reversed(replacements): s=s[:a]+v+s[b:]
    return s

for fn in files:
    p=Path(fn)
    s=p.read_text()
    had_owner='TEST_OWNER' in s
    s=migrate(s)
    if not had_owner:
        # Import after the first import to keep test imports grouped.
        first=s.find('import ')
        if first < 0: raise RuntimeError(fn)
        line_end=s.find('\n', first)
        s=s[:line_end+1]+'import { TEST_OWNER } from "./fixtures/registrar-host.js";\n'+s[line_end+1:]
    p.write_text(s)
