import * as React from 'react'

/** Must equal the host-side settings namespace (`SETTINGS_NAMESPACE` in index.ts). */
const SETTINGS_NS = 'subagent-preset-in-process'

/**
 * Browser client half of dsh-subagent-preset-in-process. Registers a
 * `settings.plugin.item` card (keyed by the host settings namespace) so the
 * provider/crew config is editable in Settings → Plugins.
 *
 * The `provider` + `model` scalars are edited as ONE dropdown populated from
 * the host's `llm.models` catalog — the same provider groups and model ids the
 * DSH model selector renders — so the two fields can never drift apart. The
 * remaining scalars read via the bound settingsScope snapshot and write with
 * `set(field, value)` / `unset(field)`; `crews` is edited as a JSON document.
 */

type Snapshot = {
  status: 'loading' | 'ready' | 'unavailable'
  writable: boolean
  value?: Record<string, unknown>
  base?: unknown
  user?: unknown
  revision?: number
}

type Scope = {
  getSnapshot(): Snapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** Host `llm.models` catalog shapes (same groups the model selector renders). */
type CatalogModel = { id: string; name: string; description?: string }
type CatalogGroup = { id: string; name: string; models: CatalogModel[] }
type CatalogFailure = { id: string; name: string; message: string }

type ModelResponse = {
  result:
    | { ok: true; value: { groups: CatalogGroup[]; failures: CatalogFailure[] } }
    | { ok: false; error: { code: string; message: string } }
}

type Api = {
  llm: {
    models(payload: Record<string, never>): Promise<ModelResponse>
  }
}

const TEXT_FIELDS = ['providerName', 'presetId', 'maxTokens', 'maxDepth'] as const

const LABELS: Record<string, string> = {
  providerName: 'Provider name',
  presetId: 'Preset id',
  maxTokens: 'Max tokens',
  maxDepth: 'Max depth',
}

/** Separates the provider id and model id inside a dropdown option value. */
const MODEL_SEP = '\u0000'

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, marginBottom: 4, color: 'var(--dsw-alias-label-secondary, #555)' }
const inputStyle: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '6px 10px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #ccc)', background: 'var(--dsw-alias-bg-layer-3, #fff)', color: 'var(--dsw-alias-label-primary, #111)' }
const saveStyle: React.CSSProperties = { padding: '8px 16px', borderRadius: 6, border: 'none', background: 'var(--dsw-alias-label-primary, #111)', color: 'var(--dsw-alias-bg-layer-3, #fff)', cursor: 'pointer' }

function Card({ scope, api }: { scope: Scope; api: Api | undefined }) {
  const [snap, setSnap] = React.useState<Snapshot>(() => scope.getSnapshot())
  React.useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  const [draft, setDraft] = React.useState<Record<string, string>>(() => {
    const v = scope.getSnapshot().value ?? {}
    const out: Record<string, string> = {}
    for (const k of TEXT_FIELDS) {
      const val = v[k]
      out[k] = val === undefined || val === null ? '' : String(val)
    }
    out.crews = JSON.stringify(v.crews ?? {}, null, 2)
    return out
  })

  // The unified provider+model selection (resolved value, so it also shows the
  // composition default until the user overrides it).
  const [modelSel, setModelSel] = React.useState<string>(() => {
    const v = scope.getSnapshot().value ?? {}
    const provider = v.provider
    const model = v.model
    if (typeof provider === 'string' && typeof model === 'string' && provider !== '' && model !== '') {
      return provider + MODEL_SEP + model
    }
    return ''
  })

  const [groups, setGroups] = React.useState<CatalogGroup[]>([])
  const [catalogStatus, setCatalogStatus] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const [catalogError, setCatalogError] = React.useState('')

  React.useEffect(() => {
    if (api === undefined) {
      setCatalogStatus('error')
      setCatalogError('Model catalog unavailable: no connection to the host.')
      return
    }
    let cancelled = false
    setCatalogStatus('loading')
    setCatalogError('')
    ;(async () => {
      try {
        const resp = await api.llm.models({})
        if (cancelled) return
        if (!resp.result.ok) {
          setCatalogStatus('error')
          setCatalogError(`${resp.result.error.code}: ${resp.result.error.message}`)
          return
        }
        setGroups(resp.result.value.groups)
        setCatalogStatus('ready')
      } catch (e) {
        if (cancelled) return
        setCatalogStatus('error')
        setCatalogError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => { cancelled = true }
  }, [api])

  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState('')

  if (snap.status === 'unavailable') {
    return React.createElement('p', null, 'Settings unavailable for this plugin.')
  }
  if (!snap.writable) {
    return React.createElement('p', null, 'Settings are read-only in this deployment.')
  }

  const textField = (field: string) =>
    React.createElement('div', { key: field, style: { marginBottom: 12 } },
      React.createElement('label', { style: labelStyle }, LABELS[field] ?? field),
      React.createElement('input', {
        value: draft[field] ?? '',
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, [field]: e.target.value })),
        style: inputStyle,
      }),
    )

  // The resolved selection may predate the catalog (an adapter no longer
  // advertises a model it still serves). Keep it as a fallback option so the
  // dropdown never silently blanks the effective value.
  const known = groups.flatMap((g) => g.models.map((m) => g.id + MODEL_SEP + m.id))
  const selectionKnown = modelSel === '' || known.includes(modelSel)
  const labelFor = (key: string) => {
    const idx = key.indexOf(MODEL_SEP)
    if (idx < 0) return key
    return `${key.slice(0, idx)} / ${key.slice(idx + 1)}`
  }

  const modelField = React.createElement('div', { style: { marginBottom: 12 } },
    React.createElement('label', { style: labelStyle }, 'Model'),
    catalogStatus === 'loading'
      ? React.createElement('p', { style: { margin: '0 0 4px', color: 'var(--dsw-alias-label-tertiary, #888)' } }, 'Loading model catalog…')
      : catalogStatus === 'error'
        ? React.createElement('p', { style: { margin: '0 0 4px', color: '#d92d20' } }, catalogError)
        : null,
    React.createElement('select', {
      value: modelSel,
      onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setModelSel(e.target.value),
      style: inputStyle,
    },
      React.createElement('option', { value: '' }, 'Use composition default'),
      !selectionKnown
        ? React.createElement('option', { value: modelSel }, `${labelFor(modelSel)} (current)`)
        : null,
      groups.map((group) =>
        React.createElement('optgroup', { key: group.id, label: group.name },
          group.models.map((model) =>
            React.createElement('option', {
              key: group.id + MODEL_SEP + model.id,
              value: group.id + MODEL_SEP + model.id,
            }, model.description ? `${model.name} — ${model.description}` : model.name),
          ),
        ),
      ),
    ),
  )

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      for (const field of ['providerName', 'presetId']) {
        const v = draft[field] ?? ''
        if (v === '') await scope.unset(field)
        else await scope.set(field, v)
      }
      // Unified provider/model: one dropdown writes both fields together.
      const sep = modelSel.indexOf(MODEL_SEP)
      if (modelSel === '' || sep < 0) {
        await scope.unset('provider')
        await scope.unset('model')
      } else {
        await scope.set('provider', modelSel.slice(0, sep))
        await scope.set('model', modelSel.slice(sep + 1))
      }
      const maxTokens = draft.maxTokens
      if (maxTokens === undefined || maxTokens === '') await scope.unset('maxTokens')
      else await scope.set('maxTokens', Number(maxTokens))
      const maxDepth = draft.maxDepth
      if (maxDepth === undefined || maxDepth === '') await scope.unset('maxDepth')
      else if (maxDepth === 'provider-managed') await scope.set('maxDepth', 'provider-managed')
      else await scope.set('maxDepth', Number(maxDepth))
      const crews = draft.crews ?? '{}'
      if (crews.trim() === '' || crews.trim() === '{}') await scope.unset('crews')
      else await scope.set('crews', JSON.parse(crews))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return React.createElement('div', { style: { padding: '4px 0' } },
    ...TEXT_FIELDS.map(textField),
    modelField,
    React.createElement('div', { style: { marginBottom: 8 } },
      React.createElement('label', { style: labelStyle }, 'Crews (JSON)'),
      React.createElement('p', { style: { margin: '0 0 6px', fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', lineHeight: 1.4 } },
        'Routed (model chooses next role) or pipeline (ordered chain with verify-gate). Each role carries roleTask + tasks [{id,title,acceptanceCriteria,status}], and may pin its own route with agentOptions {provider,model,maxTokens} (wins over the settings above, field by field; legacy flat provider/model/maxTokens still work as aliases). Example: {"engineering":{"mode":"pipeline","roles":[{"name":"planner","presetId":"subagent-slim","roleTask":"Plan","tasks":[{"id":"T1","title":"Implement X","acceptanceCriteria":"Tests pass","status":"pending"}]},{"name":"verifier","presetId":"subagent-slim","roleTask":"Verify T1","agentOptions":{"model":"gpt-5.6-sol"}}],"pipeline":{"order":["planner","builder","verifier"],"verifyGate":{"verifierRole":"verifier","maxRetries":3}}}} — use crew_status to read each role\'s effective route, and crew_pipeline_status / crew_verify / crew_task_update at runtime.'),
      React.createElement('textarea', {
        value: draft.crews ?? '',
        rows: 12,
        onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft((d) => ({ ...d, crews: e.target.value })),
        style: { ...inputStyle, height: 180, fontFamily: 'monospace', whiteSpace: 'pre', fontSize: 11 },
      }),
    ),
    error ? React.createElement('p', { style: { color: '#d92d20' } }, error) : null,
    React.createElement('button', { onClick: save, disabled: saving, style: saveStyle },
      saving ? 'Saving…' : 'Save'),
  )
}

export const name = 'subagent-preset-in-process-client'
export const inject = ['slots', 'settingsScope', 'connection', 'remote']

export function apply(ctx: any): void {
  const scope: Scope = ctx.settingsScope.bind({ namespace: SETTINGS_NS })
  const api: Api | undefined = ctx.connection?.api
  ctx.slots.inject('settings.plugin.item', () =>
    ctx.slots.register(
      { name: 'settings.plugin.item', key: SETTINGS_NS, inject: () => ({ scope, api }) },
      (props: { scope: Scope; api: Api | undefined }) => React.createElement(Card, { scope: props.scope, api: props.api }),
    ),
  )
}
