// keys(), the batched keystroke method, driven through the production batch
// loop and per-stroke delivery against a modelled plugin: strokes go out in
// order under one burst, a refusal of the first stroke is the D-Bus error key()
// would send, and a later refusal ends the batch with the count instead.
#include <algorithm>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using uint = unsigned int;
using qsizetype = long long;
struct QString : std::string {
    using std::string::string;
    QString(const std::string& s) : std::string(s) {}
    template <class T> QString arg(T value) const {
        std::string out = *this;
        const auto at = out.find('%');
        if (at != std::string::npos) out.replace(at, 2, std::to_string(value));
        return out;
    }
};
#define QStringLiteral(literal) QString(literal)
struct QDBusError {
    enum ErrorType { InvalidArgs };
};
template <class T> struct QList : std::vector<T> {
    using std::vector<T>::vector;
    qsizetype size() const { return qsizetype(std::vector<T>::size()); }
    bool contains(const T& v) const { return std::find(this->begin(), this->end(), v) != this->end(); }
};
struct Window {};
struct SynaraKeyStroke {
    uint keyCode = 0;
    bool pressed = false;
};
static constexpr qsizetype s_maxKeyStrokes = 256;

struct SynaraComputerUsePlugin;
struct Auth {
    bool permits(const SynaraComputerUsePlugin&) const { return true; }
};

struct SynaraComputerUsePlugin {
    enum class InputKind { Pointer, Keyboard };
    class DirectInjectionScope {
    public:
        explicit DirectInjectionScope(SynaraComputerUsePlugin* plugin) : m_plugin(plugin) { ++m_plugin->scopes; ++m_plugin->depth; }
        ~DirectInjectionScope() { if (--m_plugin->depth == 0) ++m_plugin->restores; }
    private:
        SynaraComputerUsePlugin* m_plugin;
    };

    Auth m_auth;
    bool m_running = true;
    bool m_quietRefusals = false;
    bool locked = false;
    int scopes = 0, depth = 0, restores = 0, activity = 0;
    // Refuse every stroke from this index on, as if the human's guard fired
    // there (-1: never).
    int refuseFrom = -1;
    Window window;
    Window* m_keyboardWindow = &window;
    bool m_keyboardDirect = true;
    QList<uint> m_pressedKeys;
    std::vector<std::pair<uint, bool>> sent;
    mutable std::vector<std::string> errors;

    bool calledFromDBus() const { return true; }
    void sendErrorReply(const QString& name, const QString&) const { errors.push_back(name); }
    void sendErrorReply(QDBusError::ErrorType, const QString&) const { errors.push_back("InvalidArgs"); }
    bool refuseIfSessionLocked() const {
        if (locked) errors.push_back("SessionLocked");
        return locked;
    }
    bool requireRunning() {
        if (!m_running) return false;
        ++activity;
        return true;
    }
    bool inputReady() const { return true; }
    // Focusing the target is the first wire event a key sends (an enter, the
    // modifiers, a borrowed activation); the model counts it.
    int focusUpdates = 0;
    Window* resolveKeyboardWindow() const { return m_keyboardWindow; }
    bool directPathFor(const Window*, const Window*, bool currentDirect) const { return currentDirect; }
    bool updateKeyboardFocus() { ++focusUpdates; return true; }
    bool requireReachableClient(const Window*, bool) { return true; }
    bool refuseIfHumanActive(const Window*, bool, InputKind) {
        const bool active = refuseFrom >= 0 && int(sent.size()) >= refuseFrom;
        if (active) sendRefusal("org.synara.ComputerUse.Error.HumanActive", "busy");
        return active;
    }
    void sendKey(uint keyCode, bool pressed) {
        sent.push_back({keyCode, pressed});
        if (pressed) m_pressedKeys.push_back(keyCode);
        else m_pressedKeys.erase(std::remove(m_pressedKeys.begin(), m_pressedKeys.end(), keyCode), m_pressedKeys.end());
    }

    uint keys(const QList<SynaraKeyStroke>& strokes);
    bool deliverKey(uint keyCode, bool pressed);
    void sendRefusal(const QString& name, const QString& message) const;
};

// PRODUCTION_DEFINITIONS

void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

QList<SynaraKeyStroke> word(int letters) {
    QList<SynaraKeyStroke> strokes;
    for (int i = 0; i < letters; ++i) {
        strokes.push_back({uint(30 + i), true});
        strokes.push_back({uint(30 + i), false});
    }
    return strokes;
}

int main() {
    try {
        {
            SynaraComputerUsePlugin plugin;
            const uint delivered = plugin.keys(word(3));
            check(delivered == 6 && plugin.sent.size() == 6, "every stroke of a clean batch is delivered");
            check(plugin.sent[0] == std::make_pair(30u, true) && plugin.sent[5] == std::make_pair(32u, false), "in order");
            check(plugin.scopes == 1 && plugin.restores == 1, "one batch is one burst: the human's objects are handed back once");
            check(plugin.activity == 1 && plugin.errors.empty(), "one admission, no error");
        }
        {
            SynaraComputerUsePlugin plugin;
            plugin.refuseFrom = 0;
            const uint delivered = plugin.keys(word(2));
            check(delivered == 0 && plugin.sent.empty(), "a refused first stroke sends nothing");
            check(plugin.focusUpdates == 0, "not even the focus change: the refusal comes before any wire event");
            check(plugin.errors.size() == 1 && plugin.errors[0] == "org.synara.ComputerUse.Error.HumanActive", "and is key()'s error");
        }
        {
            // Refused at the third stroke: the batch stops there and answers
            // with the count, with no error reply, which QtDBus would send in
            // place of the count.
            SynaraComputerUsePlugin plugin;
            plugin.refuseFrom = 2;
            const uint delivered = plugin.keys(word(3));
            check(delivered == 2 && plugin.sent.size() == 2, "a batch stops at the first stroke not delivered");
            check(plugin.focusUpdates == 2, "the refused third stroke focused nothing");
            check(plugin.errors.empty(), "a refusal after the first stroke is the count, not an error");
            check(!plugin.m_quietRefusals, "the quiet flag never outlives the batch");
            plugin.refuseFrom = 0;
            check(plugin.keys(word(1)) == 0 && plugin.errors.size() == 1, "the next call's first refusal is an error again");
        }
        {
            // A release completing the agent's own press is never refused, so
            // a batch cut short mid-chord can still be finished.
            SynaraComputerUsePlugin plugin;
            plugin.refuseFrom = 1;
            check(plugin.keys(QList<SynaraKeyStroke>{{29, true}, {30, true}}) == 1, "the second press is refused");
            check(plugin.keys(QList<SynaraKeyStroke>{{29, false}}) == 1 && plugin.m_pressedKeys.empty(), "the held Ctrl is still released");
        }
        {
            SynaraComputerUsePlugin plugin;
            const uint delivered = plugin.keys(word(129));
            check(delivered == 0 && plugin.sent.empty() && plugin.errors.size() == 1 && plugin.errors[0] == "InvalidArgs", "more than 256 strokes is InvalidArgs and sends nothing");
            SynaraComputerUsePlugin stopped;
            stopped.m_running = false;
            check(stopped.keys(word(1)) == 0 && stopped.sent.empty(), "a stopped session delivers nothing");
            SynaraComputerUsePlugin locked;
            locked.locked = true;
            check(locked.keys(word(1)) == 0 && locked.errors.size() == 1 && locked.errors[0] == "SessionLocked", "locked refuses with SessionLocked");
        }
    } catch (const std::exception& failure) {
        std::cout << "FAILED: " << failure.what() << "\n";
        return 1;
    }
    std::cout << "keys(): ordered delivery in one burst, key()'s error for the first refusal, the count for a later one.\n";
}
