// healthJson's two registration facts: the release shortcut that actually
// fires, and whether this instance holds the bus name.
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

struct QString : std::string {
    using std::string::string;
    QString(const std::string& s) : std::string(s) {}
};
#define QStringLiteral(literal) QString(literal)
struct QKeySequence {
    enum Format { NativeText };
    std::string text;
    bool isEmpty() const { return text.empty(); }
    QString toString(Format) const { return text; }
};
template <class T> using QList = std::vector<T>;
struct QJsonValue {
    bool null = true;
    std::string text;
    QJsonValue() = default;
    QJsonValue(const QString& s) : null(false), text(s) {}
    bool isNull() const { return null; }
};
struct QAction {};
struct KGlobalAccel {
    QList<QKeySequence> bound;
    static KGlobalAccel* self() { static KGlobalAccel instance; return &instance; }
    QList<QKeySequence> shortcut(const QAction*) const { return bound; }
};
struct QDBusConnection {
    enum RegisterOption { ExportAllInvokables = 1, ExportScriptableSignals = 2 };
    static bool nameAvailable, pathAvailable;
    static QDBusConnection sessionBus() { return {}; }
    bool registerService(const QString&) { return nameAvailable; }
    template <class T> bool registerObject(const QString&, const QString&, T*, int) { return pathAvailable; }
};
bool QDBusConnection::nameAvailable = false;
bool QDBusConnection::pathAvailable = false;
QString s_service = "org.synara.ComputerUse";
QString s_path = "/org/synara/ComputerUse";
QString s_interface = "org.synara.ComputerUse1";

struct SynaraComputerUsePlugin {
    QAction action;
    QAction* m_releaseAction = &action;
    QKeySequence m_effectiveReleaseShortcut;
    bool m_serviceRegistered = false;
    bool m_objectRegistered = false;
    void updateEffectiveReleaseShortcut();
    QJsonValue releaseShortcutJson() const;
    QString releaseShortcutText() const;
    void registerOnBus();
    void handleServiceUnregistered();
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int main() {
    try {
        SynaraComputerUsePlugin plugin;

        // Nothing bound: health must say so with null, and messages must still read.
        KGlobalAccel::self()->bound = {};
        plugin.updateEffectiveReleaseShortcut();
        check(plugin.releaseShortcutJson().isNull(), "no bound shortcut must be published as null");
        check(!plugin.releaseShortcutText().empty(), "a message still needs words for the missing shortcut");

        // KGlobalAccel bound something other than the default (a remap).
        KGlobalAccel::self()->bound = {QKeySequence{""}, QKeySequence{"Meta+F12"}};
        plugin.updateEffectiveReleaseShortcut();
        check(plugin.releaseShortcutJson().text == "Meta+F12", "the effective sequence is what is published");
        check(plugin.releaseShortcutText() == "Meta+F12", "messages name the effective sequence");

        // An older build in the same process still exports the object path;
        // the shared connection already owns the name, so that half succeeds.
        QDBusConnection::pathAvailable = false;
        QDBusConnection::nameAvailable = true;
        plugin.registerOnBus();
        check(!plugin.m_objectRegistered, "a taken object path is reported as not exported");
        check(plugin.m_serviceRegistered, "the name held by this process counts as registered");
        // The older build unloads: it releases the path, then the name.
        QDBusConnection::pathAvailable = true;
        plugin.handleServiceUnregistered();
        check(plugin.m_objectRegistered && plugin.m_serviceRegistered, "both halves are taken when the previous holder lets go");
        QDBusConnection::pathAvailable = false;
        QDBusConnection::nameAvailable = false;
        plugin.registerOnBus();
        check(plugin.m_objectRegistered && plugin.m_serviceRegistered, "held registrations are not re-requested");
        // A name that is refused outright stays reported as missing.
        SynaraComputerUsePlugin other;
        QDBusConnection::pathAvailable = true;
        plugin.registerOnBus();
        other.registerOnBus();
        check(other.m_objectRegistered && !other.m_serviceRegistered, "a refused name is reported as not registered while the object is exported");
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "healthJson reports the effective release shortcut, the bus name and the object export.\n";
}
