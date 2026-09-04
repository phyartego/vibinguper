import { expect, test } from '@playwright/test'
import { VB_CDC_ERR } from '../shared/cdc-file-protocol'
import {
  assertCanSaveAsText,
  classifyFile,
  isBinaryPlaceholder,
  isExamplesPlugin,
  isNativePlugin,
  isSystemPlugin,
  nestFilePaths,
  parseDeviceError,
  parseFileListResponse,
  saveFailureState
} from '../shared/plugin-files'

test('classifies text, image, binary and utf-8 without nul', () => {
  expect(classifyFile('main.py', new TextEncoder().encode('print(1)'))).toBe('text')
  expect(classifyFile('assets/a.png', new Uint8Array([0x89, 0x50]))).toBe('image')
  expect(classifyFile('data.bin', new Uint8Array([0, 1, 2]))).toBe('binary')
  expect(classifyFile('notes', new TextEncoder().encode('hello'))).toBe('text')
  expect(classifyFile('notes', new Uint8Array([0x80]))).toBe('binary')
})

test('refuses binary placeholder and binary extensions as text', () => {
  expect(isBinaryPlaceholder('[binary 12 bytes]')).toBe(true)
  expect(() => assertCanSaveAsText('a.png', 'not-an-image')).toThrow(/UTF-8/)
  expect(() => assertCanSaveAsText('main.py', '[binary 4 bytes]')).toThrow(/UTF-8/)
  expect(() => assertCanSaveAsText('main.py', 'print(1)')).not.toThrow()
})

test('hides system, marks examples readonly, native firmware ids', () => {
  expect(isSystemPlugin('system')).toBe(true)
  expect(isExamplesPlugin('examples')).toBe(true)
  expect(isNativePlugin({ id: 'clock', native: true })).toBe(true)
  expect(isNativePlugin({ id: 'session_card' })).toBe(true)
  expect(isNativePlugin({ id: 'hello_tick' })).toBe(false)
})

test('file list pagination parser and tree nesting', () => {
  const listed = parseFileListResponse([{ name: 'a.py', type: 'file', size: 1 }])
  expect(listed.complete).toBe(true)
  expect(listed.entries[0]?.name).toBe('a.py')
  expect(listed.entries[0]?.type).toBe('file')
  const page = parseFileListResponse({
    entries: [{ name: 'scripts', type: 'dir', size: 0 }],
    cursor: 'next-1'
  })
  expect(page.complete).toBe(false)
  expect(page.cursor).toBe('next-1')
  const tree = nestFilePaths([
    { name: 'main.py', path: 'main.py', type: 'file', size: 9 },
    { name: 'a.png', path: 'assets/a.png', type: 'file', size: 4 }
  ])
  expect(tree.map((n) => n.name).sort()).toEqual(['assets', 'main.py'])
  const assets = tree.find((n) => n.name === 'assets')
  expect(assets?.children?.[0]?.path).toBe('assets/a.png')
})

test('save-and-run failure keeps editor buffer', () => {
  const prev = { text: 'print("keep me")' }
  const failed = saveFailureState(
    prev,
    new Error(`CDC_ERR ${VB_CDC_ERR.VM_START_FAILED}: vm exploded`)
  )
  expect(failed.text).toBe('print("keep me")')
  expect(failed.dirty).toBe(true)
  expect(failed.error).toContain('vm exploded')
  expect(parseDeviceError(failed.error).message).toBeDefined()
})
