// noema-input-source: keeps the keyboard Latin outside Vim Insert.
//
// A long-lived helper owned by the Noema host. It reads one command per line
// on stdin and exits when stdin closes (the host ended or crashed):
//
//   normal   remember the current input source if it is not a Latin keyboard
//            layout, then select one (ABC, else U.S., else any ASCII layout)
//   restore  select the remembered input source again and forget it
//   current  print the current input source id
//
// Each command answers one line on stdout: "ok <id>" or "error <message>".
// It only selects input sources the user already enabled; it changes no
// setting and needs no permission.
import Carbon
import Foundation

func sourceID(_ source: TISInputSource) -> String {
  guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceID) else { return "" }
  return Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
}

func boolProperty(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let raw = TISGetInputSourceProperty(source, key) else { return false }
  return CFBooleanGetValue(Unmanaged<CFBoolean>.fromOpaque(raw).takeUnretainedValue())
}

func isLatinLayout(_ source: TISInputSource) -> Bool {
  guard let raw = TISGetInputSourceProperty(source, kTISPropertyInputSourceType) else { return false }
  let type = Unmanaged<CFString>.fromOpaque(raw).takeUnretainedValue() as String
  return type == (kTISTypeKeyboardLayout as String) && boolProperty(source, kTISPropertyInputSourceIsASCIICapable)
}

func enabledSources() -> [TISInputSource] {
  let filter = [kTISPropertyInputSourceIsSelectCapable as String: true] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, false)?.takeRetainedValue() as? [TISInputSource] else { return [] }
  return list
}

func latinLayout() -> TISInputSource? {
  let sources = enabledSources().filter(isLatinLayout)
  for preferred in ["com.apple.keylayout.ABC", "com.apple.keylayout.US"] {
    if let match = sources.first(where: { sourceID($0) == preferred }) { return match }
  }
  return sources.first
}

var remembered: String? = nil

func answer(_ line: String) {
  FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func run(_ command: String) {
  let current = TISCopyCurrentKeyboardInputSource().takeRetainedValue()
  switch command {
  case "current":
    answer("ok \(sourceID(current))")
  case "normal":
    if isLatinLayout(current) { answer("ok \(sourceID(current))"); return }
    guard let latin = latinLayout() else { answer("error no Latin keyboard layout is enabled"); return }
    remembered = sourceID(current)
    let status = TISSelectInputSource(latin)
    answer(status == noErr ? "ok \(sourceID(latin))" : "error select failed \(status)")
  case "restore":
    guard let id = remembered else { answer("ok \(sourceID(current))"); return }
    remembered = nil
    guard let source = enabledSources().first(where: { sourceID($0) == id }) else {
      answer("error input source \(id) is no longer enabled"); return
    }
    let status = TISSelectInputSource(source)
    answer(status == noErr ? "ok \(id)" : "error select failed \(status)")
  default:
    answer("error unknown command")
  }
}

if CommandLine.arguments.contains("--self-test") {
  run("current")
  exit(0)
}

while let line = readLine() {
  let command = line.trimmingCharacters(in: .whitespaces)
  if !command.isEmpty { run(command) }
}
