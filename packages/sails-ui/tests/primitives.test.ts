import { ariaSort, nextSort, sortRows } from '../src/lib/sort'
import { filterOptions, moveActive, normalize, typeaheadIndex } from '../src/lib/combobox'
import { busyProps } from '../src/lib/busy'
import { TOAST_MS, toastDuration } from '../src/lib/toast'

describe('table sorting', () => {
  const rows = [
    { name: 'Maré', price: 10 },
    { name: 'ana', price: null as number | null },
    { name: 'Bruno', price: 2 },
    { name: 'Álvaro', price: 10 },
  ]
  const get = (r: (typeof rows)[number], k: string) => (k === 'price' ? r.price : r.name)

  it('cycles a column ascending -> descending and restarts on a new column', () => {
    const a = nextSort(null, 'price')
    expect(a).toEqual({ key: 'price', direction: 'ascending' })
    expect(nextSort(a, 'price')).toEqual({ key: 'price', direction: 'descending' })
    expect(nextSort(nextSort(a, 'price'), 'name')).toEqual({ key: 'name', direction: 'ascending' })
    expect(ariaSort(a, 'price')).toBe('ascending')
    expect(ariaSort(a, 'name')).toBe('none')
    expect(ariaSort(null, 'name')).toBe('none')
  })

  it('sorts numbers numerically, keeps ties stable and puts empty values last both ways', () => {
    expect(sortRows(rows, { key: 'price', direction: 'ascending' }, get).map((r) => r.name)).toEqual(['Bruno', 'Maré', 'Álvaro', 'ana'])
    expect(sortRows(rows, { key: 'price', direction: 'descending' }, get).map((r) => r.name)).toEqual(['Maré', 'Álvaro', 'Bruno', 'ana'])
  })

  it('sorts text with pt-BR collation (accents, case) and leaves input untouched without a sort', () => {
    expect(sortRows(rows, { key: 'name', direction: 'ascending' }, get).map((r) => r.name)).toEqual(['Álvaro', 'ana', 'Bruno', 'Maré'])
    expect(sortRows(rows, null, get)).toEqual(rows)
    expect(sortRows(rows, null, get)).not.toBe(rows)
  })
})

describe('combobox filtering and keyboard', () => {
  const options = [
    { value: 'BTC', label: 'Bitcoin', keywords: ['BTC'] },
    { value: 'USDT_LIQUID', label: 'USDT (Liquid)' },
    { value: 'PIX', label: 'Pix' },
    { value: 'TED', label: 'Transferência bancária' },
  ]

  it('matches label, value and keywords, ignoring case and accents', () => {
    expect(filterOptions(options, '').map((o) => o.value)).toEqual(['BTC', 'USDT_LIQUID', 'PIX', 'TED'])
    expect(filterOptions(options, 'bit').map((o) => o.value)).toEqual(['BTC'])
    expect(filterOptions(options, 'liquid').map((o) => o.value)).toEqual(['USDT_LIQUID'])
    expect(filterOptions(options, 'transferencia').map((o) => o.value)).toEqual(['TED'])
    expect(filterOptions(options, '  PIX ').map((o) => o.value)).toEqual(['PIX'])
    expect(filterOptions(options, 'zzz')).toEqual([])
    expect(normalize('Maré Ação')).toBe('mare acao')
  })

  it('moves the active option with wrap-around, Home and End', () => {
    expect(moveActive(-1, 3, 'ArrowDown')).toBe(0)
    expect(moveActive(-1, 3, 'ArrowUp')).toBe(2)
    expect(moveActive(2, 3, 'ArrowDown')).toBe(0)
    expect(moveActive(0, 3, 'ArrowUp')).toBe(2)
    expect(moveActive(1, 3, 'Home')).toBe(0)
    expect(moveActive(1, 3, 'End')).toBe(2)
    expect(moveActive(0, 0, 'ArrowDown')).toBe(-1)
  })

  it('typeahead finds the next item by prefix, wrapping, accent-insensitive', () => {
    const labels = ['Copiar chave pública', 'Meu perfil', 'Configurações', 'Desconectar']
    expect(typeaheadIndex(labels, 'c', 0)).toBe(2)
    expect(typeaheadIndex(labels, 'c', 2)).toBe(0)
    expect(typeaheadIndex(labels, 'de', -1)).toBe(3)
    expect(typeaheadIndex(labels, 'x', 0)).toBe(-1)
    expect(typeaheadIndex(labels, '', 0)).toBe(-1)
  })
})

describe('busy buttons', () => {
  it('the running action shows loading, the others are blocked, nothing when idle', () => {
    expect(busyProps(false, 'review', 'review')).toEqual({})
    expect(busyProps(true, 'review', 'review')).toEqual({ loading: true })
    expect(busyProps(true, 'review', 'cancel')).toEqual({ disabled: true })
    expect(busyProps(true, null, 'cancel')).toEqual({ disabled: true })
  })
})

describe('toast durations', () => {
  it('short for confirmations, longer for warnings/errors, longest with an action', () => {
    expect(toastDuration('success', false)).toBe(TOAST_MS.short)
    expect(toastDuration('info', false)).toBe(TOAST_MS.short)
    expect(toastDuration('default', false)).toBe(TOAST_MS.short)
    expect(toastDuration('warning', false)).toBe(TOAST_MS.long)
    expect(toastDuration('error', false)).toBe(TOAST_MS.long)
    expect(toastDuration('success', true)).toBe(TOAST_MS.action)
    expect(TOAST_MS.short).toBeLessThan(TOAST_MS.long)
    expect(TOAST_MS.long).toBeLessThan(TOAST_MS.action)
  })
})
