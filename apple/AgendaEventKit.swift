// Native EventKit boundary. JSON lines on stdio; no files, Org or polling.
import AppKit
import CryptoKit
import EventKit
import Foundation

typealias JSON = [String: Any]
struct BridgeError: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) -> BridgeError { BridgeError(code: code, message: message) }
func string(_ body: JSON, _ key: String) throws -> String {
    guard let value = body[key] as? String, !value.isEmpty, value.utf8.count <= 4096 else {
        throw fail("EINVAL", "Missing or invalid \(key)")
    }
    return value
}
func canonical(_ value: JSON) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func revision(_ value: JSON) throws -> String {
    SHA256.hash(data: try canonical(value)).map { String(format: "%02x", $0) }.joined()
}
func same(_ left: JSON, _ right: JSON) -> Bool { (try? canonical(left)) == (try? canonical(right)) }
func emit(_ body: JSON) {
    guard var data = try? canonical(body) else { return }
    data.append(10)
    FileHandle.standardOutput.write(data)
}

// A date remains a civil date, with optional time and an explicit zone. Floating
// reminder dates retain their semantics instead of becoming UTC midnight.
struct CivilDate {
    let date: Date
    let components: DateComponents
    let zone: TimeZone?
    let timed: Bool
    init(_ value: JSON) throws {
        let day = try string(value, "date"), zoneName = try string(value, "timeZone")
        zone = zoneName == "floating" ? nil : TimeZone(identifier: zoneName)
        if zone == nil && zoneName != "floating" { throw fail("EINVAL", "Unknown time zone") }
        let time = value["time"] as? String
        timed = time != nil
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone ?? .current
        formatter.dateFormat = timed ? "yyyy-MM-dd HH:mm" : "yyyy-MM-dd"
        formatter.isLenient = false
        let text = day + (time.map { " " + $0 } ?? "")
        guard let parsed = formatter.date(from: text), formatter.string(from: parsed) == text else {
            throw fail("EINVAL", "Invalid civil date or nonexistent local time")
        }
        date = parsed
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone ?? .current
        var parts = calendar.dateComponents(timed ? [.year,.month,.day,.hour,.minute] : [.year,.month,.day], from: parsed)
        parts.calendar = calendar; parts.timeZone = zone
        components = parts
    }
    static func value(_ date: Date, zone: TimeZone?, timed: Bool) -> JSON {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = zone ?? .current
        formatter.dateFormat = "yyyy-MM-dd"
        var result: JSON = ["date":formatter.string(from: date), "timeZone":zone?.identifier ?? "floating"]
        if timed { formatter.dateFormat = "HH:mm"; result["time"] = formatter.string(from: date) }
        return result
    }
}

@MainActor final class AgendaEventKit {
    private lazy var store = EKEventStore()
    private var requests: [JSON] = []
    private var busy = false
    private var observers: [NSObjectProtocol] = []
    private var notificationQueued = false
    init() {
        observers.append(NotificationCenter.default.addObserver(forName: .EKEventStoreChanged, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.changed() }
        })
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.changed() }
        })
    }
    private func changed() {
        guard !notificationQueued else { return }
        notificationQueued = true
        DispatchQueue.main.async { [weak self] in
            self?.notificationQueued = false
            emit(["event":"changed"])
        }
    }
    func enqueue(_ body: JSON) {
        guard requests.count < 256 else {
            emit(["id":body["id"] ?? NSNull(), "error":["code":"EBUSY", "message":"Apple request queue is full"]]); return
        }
        requests.append(body); drain()
    }
    private func drain() {
        guard !busy, !requests.isEmpty else { return }
        busy = true
        let body = requests.removeFirst()
        Task {
            do { emit(["id":body["id"] ?? NSNull(), "result":try await handle(body)]) }
            catch {
                let problem = error as? BridgeError ?? fail("EAPPLE", error.localizedDescription)
                emit(["id":body["id"] ?? NSNull(), "error":["code":problem.code,"message":problem.message]])
            }
            busy = false; drain()
        }
    }
    private func type(_ kind: String) throws -> EKEntityType {
        switch kind { case "reminder": return .reminder; case "event": return .event
        default: throw fail("EINVAL", "Kind must be reminder or event") }
    }
    private func authorized(_ kind: String) throws {
        guard EKEventStore.authorizationStatus(for: try type(kind)) == .fullAccess else {
            throw fail("EAUTH", "Enable full access explicitly before using Apple \(kind)s")
        }
    }
    private func calendar(_ ref: JSON) throws -> EKCalendar {
        let kind = try string(ref, "kind")
        try authorized(kind)
        let id = try string(ref, "calendarId")
        guard let calendar = store.calendar(withIdentifier: id), calendar.allowedEntityTypes.contains(kind == "reminder" ? .reminder : .event) else {
            throw fail("ENOCALENDAR", "Selected Apple list or calendar is unavailable")
        }
        return calendar
    }
    private func token(_ ref: JSON) throws -> URL {
        let token = try string(ref, "token")
        guard UUID(uuidString: token) != nil else { throw fail("EINVAL", "Binding token must be a UUID") }
        return URL(string: "noema://agenda/binding/\(token.lowercased())")!
    }
    private func reminders(_ calendar: EKCalendar) async throws -> [EKReminder] {
        try await withCheckedThrowingContinuation { continuation in
            store.fetchReminders(matching: store.predicateForReminders(in: [calendar])) { reminders in
                if let reminders { continuation.resume(returning: reminders) }
                else { continuation.resume(throwing: fail("EAPPLE", "Reminder fetch failed; absence is not deletion")) }
            }
        }
    }
    private func find(_ ref: JSON, calendar: EKCalendar) async throws -> EKCalendarItem? {
        let url = try token(ref), kind = try string(ref, "kind")
        func owned(_ item: EKCalendarItem) -> Bool {
            item.url == url && item.calendar.calendarIdentifier == calendar.calendarIdentifier
                && (kind == "reminder" ? item is EKReminder : item is EKEvent)
        }
        if let id = ref["itemId"] as? String, let item = store.calendarItem(withIdentifier: id) {
            guard item.url == url else { throw fail("EBINDING", "Apple binding token changed") }
            guard owned(item) else { throw fail("ERELOCATED", "Apple item moved outside its selected collection") }
            return item
        }
        if let external = ref["externalId"] as? String, !external.isEmpty {
            let items = store.calendarItems(withExternalIdentifier: external).filter(owned)
            if items.count > 1 { throw fail("EAMBIGUOUS", "Multiple Apple items have this binding") }
            if let item = items.first { return item }
        }
        // Lost-create receipts and changed IDs require one bounded collection
        // recovery query. Normal notifications read known item IDs directly.
        let candidates: [EKCalendarItem]
        if kind == "reminder" { candidates = try await reminders(calendar) }
        else {
            guard let window = ref["window"] as? JSON,
                  let start = window["start"] as? JSON, let end = window["end"] as? JSON else {
                throw fail("EINVAL", "Calendar recovery requires an explicit date window")
            }
            let from = try CivilDate(start).date, to = try CivilDate(end).date
            guard to > from, to.timeIntervalSince(from) <= 366 * 86400 else { throw fail("EINVAL", "Calendar window must be within one year") }
            candidates = store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: [calendar]))
        }
        let matches = candidates.filter(owned)
        if matches.count > 1 { throw fail("EAMBIGUOUS", "Multiple Apple items have this binding") }
        return matches.first
    }
    private func fields(_ item: EKCalendarItem) -> JSON {
        var result: JSON = ["title":item.title ?? "", "recurring":item.hasRecurrenceRules]
        if let reminder = item as? EKReminder {
            result["completed"] = reminder.isCompleted; result["priority"] = reminder.priority
            if let parts = reminder.dueDateComponents {
                var calendar = Calendar(identifier: .gregorian); calendar.timeZone = parts.timeZone ?? .current
                if let date = calendar.date(from: parts) {
                    result["due"] = CivilDate.value(date, zone: parts.timeZone, timed: parts.hour != nil)
                }
            }
            if result["due"] == nil { result["due"] = NSNull() }
        } else if let event = item as? EKEvent {
            result["allDay"] = event.isAllDay
            result["start"] = CivilDate.value(event.startDate, zone: event.timeZone, timed: !event.isAllDay)
            result["end"] = CivilDate.value(event.endDate, zone: event.timeZone, timed: !event.isAllDay)
        }
        return result
    }
    private func snapshot(_ item: EKCalendarItem) throws -> JSON {
        let value = fields(item)
        return ["itemId":item.calendarItemIdentifier, "externalId":item.calendarItemExternalIdentifier ?? "",
                "calendarId":item.calendar.calendarIdentifier, "fields":value, "revision":try revision(value)]
    }
    private func apply(_ draft: JSON, to item: EKCalendarItem) throws {
        let title = try string(draft, "title")
        guard draft["recurring"] as? Bool != true, !item.hasRecurrenceRules else {
            throw fail("ECONFLICT", "Apple recurrence requires explicit ownership; Noema mirrors one occurrence")
        }
        if let reminder = item as? EKReminder {
            guard let completed = draft["completed"] as? Bool,
                  let priority = draft["priority"] as? Int, (0...9).contains(priority) else { throw fail("EINVAL", "Invalid reminder fields") }
            guard draft["due"] is NSNull || draft["due"] is JSON else { throw fail("EINVAL", "Due must be a civil date or null") }
            let due = try (draft["due"] as? JSON).map { try CivilDate($0).components }
            reminder.title = title; reminder.priority = priority
            // EventKit resets completionDate whenever isCompleted is set true.
            // Editing a completed item's title must preserve its history.
            if reminder.isCompleted != completed { reminder.isCompleted = completed }
            reminder.dueDateComponents = due
        } else if let event = item as? EKEvent {
            guard let start = draft["start"] as? JSON, let end = draft["end"] as? JSON,
                  let allDay = draft["allDay"] as? Bool else { throw fail("EINVAL", "An event requires an explicit time block or all-day range") }
            let from = try CivilDate(start), to = try CivilDate(end)
            guard from.timed == !allDay, to.timed == !allDay, from.zone == to.zone, to.date > from.date else {
                throw fail("EINVAL", "Invalid event interval")
            }
            event.title = title; event.isAllDay = allDay; event.startDate = from.date; event.endDate = to.date; event.timeZone = from.zone
        }
    }
    private func handle(_ body: JSON) async throws -> JSON {
        let op = try string(body, "op")
        if op == "status" {
            return ["protocol":1, "reminder":EKEventStore.authorizationStatus(for: .reminder).rawValue,
                    "event":EKEventStore.authorizationStatus(for: .event).rawValue]
        }
        let kind = try string(body, "kind")
        _ = try type(kind)
        if op == "authorize" {
            let granted = try await (kind == "reminder" ? store.requestFullAccessToReminders() : store.requestFullAccessToEvents())
            return ["granted":granted]
        }
        try authorized(kind)
        if op == "collections" {
            return ["collections":store.calendars(for: try type(kind)).map {
                ["id":$0.calendarIdentifier,"title":$0.title,"sourceId":$0.source.sourceIdentifier,
                 "sourceTitle":$0.source.title,"writable":$0.allowsContentModifications] as JSON
            }]
        }
        guard ["get","put","remove"].contains(op) else { throw fail("EINVAL", "Unknown Apple operation") }
        let calendar = try calendar(body)
        let item = try await find(body, calendar: calendar)
        if op == "get" { return try item.map(snapshot) ?? ["missing":true, "scopeLimited":true] }
        guard calendar.allowsContentModifications else { throw fail("EACCES", "Selected Apple collection is read-only") }
        guard body["expectedRevision"] is NSNull || body["expectedRevision"] is String else {
            throw fail("EINVAL", "An explicit expectedRevision is required")
        }
        if let item {
            guard !item.hasRecurrenceRules else { throw fail("ECONFLICT", "Apple recurrence ownership changed") }
            let observed = try snapshot(item)
            if op == "put", let draft = body["fields"] as? JSON, same(fields(item), draft) { return observed }
            guard let expected = body["expectedRevision"] as? String, expected == observed["revision"] as? String else {
                throw fail("ECONFLICT", "Apple item changed; reconcile before writing")
            }
        } else if body["expectedRevision"] is String {
            if op == "remove" { return ["missing":true, "scopeLimited":true] }
            throw fail("EMISSING", "Bound Apple item disappeared; refusing to recreate it")
        }
        if op == "remove" {
            guard let item else { return ["missing":true, "scopeLimited":true] }
            do {
                if let reminder = item as? EKReminder { try store.remove(reminder, commit:true) }
                if let event = item as? EKEvent { try store.remove(event, span:.thisEvent, commit:true) }
            } catch { store.reset(); throw error }
            return ["removed":true]
        }
        if item == nil && body["allowCreate"] as? Bool != true {
            throw fail("EUNCONFIRMED", "Creation was not confirmed; inspect the selected collection before explicitly creating again")
        }
        guard let draft = body["fields"] as? JSON else { throw fail("EINVAL", "Missing fields") }
        let target: EKCalendarItem = item ?? (kind == "reminder" ? EKReminder(eventStore:store) : EKEvent(eventStore:store))
        try apply(draft, to:target)
        target.calendar = calendar; target.url = try token(body)
        do {
            if let reminder = target as? EKReminder { try store.save(reminder, commit:true) }
            if let event = target as? EKEvent { try store.save(event, span:.thisEvent, commit:true) }
        } catch { store.reset(); throw error }
        return try snapshot(target)
    }
}

if CommandLine.arguments.contains("--self-test") {
    do {
        let allDay = try CivilDate(["date":"2026-09-16","timeZone":"Australia/Sydney"])
        guard !allDay.timed, allDay.components.hour == nil else { throw fail("ETEST", "All-day became timed") }
        let floating = try CivilDate(["date":"2026-09-16","time":"09:30","timeZone":"floating"])
        guard floating.zone == nil, floating.components.hour == 9 else { throw fail("ETEST", "Floating date changed") }
        do { _ = try CivilDate(["date":"2026-10-04","time":"02:30","timeZone":"Australia/Sydney"]); throw fail("ETEST", "DST gap accepted") }
        catch let error as BridgeError { if error.code == "ETEST" { throw error } }
        emit(["ok":true,"civilDates":true,"dstGapRejected":true,"eventStoreAccessed":false])
    } catch { emit(["error":String(describing:error)]); exit(1) }
} else {
    Task { @MainActor in
        let bridge = AgendaEventKit()
        DispatchQueue.global(qos:.utility).async {
            while let line = readLine() {
                guard line.utf8.count <= 1024 * 1024,
                      let data = line.data(using:.utf8), let body = (try? JSONSerialization.jsonObject(with:data)) as? JSON else {
                    DispatchQueue.main.async {
                        emit(["error":["code":"EINVAL","message":"Invalid or oversized JSON request"]])
                    }
                    continue
                }
                DispatchQueue.main.async { bridge.enqueue(body) }
            }
            DispatchQueue.main.async { exit(0) }
        }
        emit(["event":"ready","protocol":1])
    }
    RunLoop.main.run()
}
