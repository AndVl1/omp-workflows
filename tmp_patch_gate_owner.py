from pathlib import Path
p=Path('packages/core/src/engine/durable.ts')
s=p.read_text()
s=s.replace('let constitutionContinuationGate: ConstitutionContinuationGate | null = null;\n\n/** Register (or clear with null) the constitution continuation gate. */\nexport function setConstitutionContinuationGate(gate: ConstitutionContinuationGate | null): void {\n  constitutionContinuationGate = gate;\n}', '''let constitutionContinuationGate: ConstitutionContinuationGate | null = null;
let constitutionContinuationGateOwner: object | ((...args: never[]) => unknown) | null = null;

/** Register (or clear with null) the constitution continuation gate. */
export function setConstitutionContinuationGate(
  gate: ConstitutionContinuationGate | null,
  owner?: object | ((...args: never[]) => unknown),
): void {
  if (!owner) throw new Error("owner_invalid: constitution continuation gate requires a canonical owner/activation source");
  if (constitutionContinuationGateOwner && constitutionContinuationGateOwner !== owner) {
    throw new Error("owner_invalid: constitution continuation gate is already owned by another activation source");
  }
  constitutionContinuationGateOwner = owner;
  constitutionContinuationGate = gate;
}''')
p.write_text(s)

p=Path('packages/core/src/index.ts')
s=p.read_text()
old='''export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
  setConstitutionContinuationGate(({ state, stage }) => {'''
new='''export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
  if (opts.owner) setConstitutionContinuationGate(({ state, stage }) => {'''
s=s.replace(old,new,1)
old2='''    return "constitution continuation blocked (" + ensured.value.status + "): constitution bootstrap remains unresolved";
  });
  if (opts.cwd && opts.owner) {'''
new2='''    return "constitution continuation blocked (" + ensured.value.status + "): constitution bootstrap remains unresolved";
  }, opts.owner);
  if (opts.cwd && opts.owner) {'''
if old2 not in s: raise SystemExit('registerTeamWorkflow closure anchor not found')
s=s.replace(old2,new2,1)
old3='''export function registerCtoTools(pi: ExtensionAPI, options: CtoToolAdapterOptions = {}): void {
  if (!pi.zod) return;
  const owner = requireOwnerSource(options.owner);
  const duplicate = claimRegistrarActivation(ctoToolRegistrations, pi as unknown as object, owner);'''
new3='''export function registerCtoTools(pi: ExtensionAPI, options: CtoToolAdapterOptions = {}): void {
  if (!pi.zod) return;
  const owner = requireOwnerSource(options.owner);
  if (options.cwd) assertOwner(options.cwd, ["workflow_tools"], owner);
  const duplicate = claimRegistrarActivation(ctoToolRegistrations, pi as unknown as object, owner);'''
if old3 not in s: raise SystemExit('CTO anchor not found')
s=s.replace(old3,new3,1)
p.write_text(s)
