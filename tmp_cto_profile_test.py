from pathlib import Path
p=Path('packages/core/test/cto-specification-execution.test.ts')
s=p.read_text()
# Add a stable manager inside each of the two mounted Ask tests, after sessionStarts declaration.
needle='''    const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const pi = {
'''
repl='''    const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
    const sessionManager = { getSessionId: () => "cto-main-session" };
    const pi = {
'''
if s.count(needle) < 2: raise SystemExit(f'expected two CTO profile anchors, got {s.count(needle)}')
s=s.replace(needle,repl,2)
# Add session manager to every session start context and every mounted execution context in these tests by local range.
start=s.find('test("mounted CTO checkpoint Ask records')
end=s.find('test("mounted CTO mapping Ask binds', start)
if start<0 or end<0: raise SystemExit('first CTO test range missing')
block=s[start:end]
block=block.replace('''      mode: "tui",
      hasUI: true,
      ui: {
''','''      mode: "tui",
      hasUI: true,
      sessionManager,
      ui: {
''',1)
# all execute ctx objects in first test: use exact cwd occurrences
block=block.replace('''undefined, undefined, { cwd: root }));''','''undefined, undefined, { cwd: root, sessionManager }));''')
s=s[:start]+block+s[end:]
start=s.find('test("mounted CTO mapping Ask binds')
end=s.find('test("', start+10)
if start<0: raise SystemExit('second CTO test range missing')
# end may find nested next test; okay
block=s[start:end]
block=block.replace('''      const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
      const pi = {
''','''      const sessionStarts: Array<(event: unknown, ctx: unknown) => unknown> = [];
      const sessionManager = { getSessionId: () => "cto-main-session" };
      const pi = {
''',1)
block=block.replace('''        mode: "tui",
        hasUI: true,
        ui: {
''','''        mode: "tui",
        hasUI: true,
        sessionManager,
        ui: {
''',1)
block=block.replace('''undefined, undefined, { cwd: root }));''','''undefined, undefined, { cwd: root, sessionManager }));''')
s=s[:start]+block+s[end:]
p.write_text(s)
