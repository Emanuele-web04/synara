#pragma once

#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusContext>
#include <QDBusMessage>
#include <QDBusReply>
#include <QDBusServiceWatcher>
#include <QElapsedTimer>
#include <QFile>
#include <QUuid>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <cstdint>
#include <functional>
#include <iterator>
#include <string>
#include <unordered_map>

/**
 * Throttles failed authenticate() attempts per bus peer.
 *
 * authenticate() is the one method any session-bus peer may call, and a
 * failed attempt is the expensive kind: a name lookup, a file stat and a read
 * on the compositor thread. A peer that fails is not heard again for
 * cooldownMs, and a peer that keeps reconnecting cannot grow the table past
 * maxTracked entries. Qt-free and clock-injected so the rule is testable on its
 * own (tests/auth_limiter_test.py); the unique name is the key, because it is
 * the one identity the bus guarantees per connection.
 */
struct ComputerUseAuthLimiter {
    static constexpr int64_t cooldownMs = 1000;
    static constexpr size_t maxTracked = 64;
    std::unordered_map<std::string, int64_t> failedAt;

    bool permits(const std::string &peer, int64_t nowMs) const
    {
        const auto it = failedAt.find(peer);
        return it == failedAt.end() || nowMs - it->second >= cooldownMs;
    }
    void noteFailure(const std::string &peer, int64_t nowMs)
    {
        if (failedAt.count(peer) == 0 && failedAt.size() >= maxTracked) {
            // Lapsed entries go first; if none has lapsed the oldest does, being
            // the closest to lapsing anyway.
            for (auto it = failedAt.begin(); it != failedAt.end();) {
                it = nowMs - it->second >= cooldownMs ? failedAt.erase(it) : std::next(it);
            }
            if (failedAt.size() >= maxTracked) {
                failedAt.erase(std::min_element(failedAt.begin(), failedAt.end(), [](const auto &a, const auto &b) {
                    return a.second < b.second;
                }));
            }
        }
        failedAt[peer] = nowMs;
    }
    void noteSuccess(const std::string &peer)
    {
        failedAt.erase(peer);
    }
};

/**
 * The server's private capability, bound to its exclusive bus connection.
 *
 * Trust boundary (README, "Threat model"): the session bus and this uid. Any
 * process of this user on the session bus can call authenticate(); to
 * succeed it must be the current owner of org.synara.ComputerUse.Server, a
 * well-known name only one connection holds at a time, and present the 64-byte
 * token in /tmp/synara-computer-use-<uid>-<bus id>.token, a regular file this
 * uid owns with mode 0600, which only this user can read. Everything else on
 * the interface except healthJson answers Unauthorized until then, and the
 * capability dies with the connection that earned it: when the name changes
 * hands the session is stopped and the next server has to authenticate afresh.
 *
 * No bus round-trip on the hot path: the name's owner is tracked from
 * NameOwnerChanged (the bus delivers that signal before any call the new owner
 * makes), the bus id is fetched once, and a peer that failed is refused
 * outright for a second (ComputerUseAuthLimiter).
 */
class ComputerUseAuth {
    const QString ownerName = QStringLiteral("org.synara.ComputerUse.Server");
    // The unique name of the connection that authenticated, empty until one has.
    QString caller;
    // The unique name currently holding ownerName, as the bus last told us.
    QString ownerUniqueName;
    // org.freedesktop.DBus.GetId, fetched on first use; part of the token path.
    QString busId;
    QDBusServiceWatcher watcher;
    QElapsedTimer clock;
    ComputerUseAuthLimiter limiter;
    const QString instance = QUuid::createUuid().toString(QUuid::WithoutBraces);
public:
    std::function<void()> onRevoked;
    ComputerUseAuth()
        : watcher(ownerName, QDBusConnection::sessionBus(), QDBusServiceWatcher::WatchForOwnerChange)
    {
        clock.start();
        ownerUniqueName = lookupOwner();
        QObject::connect(&watcher, &QDBusServiceWatcher::serviceOwnerChanged, &watcher,
            [this](const QString &, const QString &, const QString &newOwner) {
                ownerUniqueName = newOwner;
                caller.clear();
                if (onRevoked) onRevoked();
            });
    }
    QString authenticate(const QDBusContext &context, const QString &token)
    {
        if (!context.calledFromDBus()) return {};
        const QString peer = context.message().service();
        const std::string key = peer.toStdString();
        const int64_t now = clock.elapsed();
        if (!limiter.permits(key, now)) {
            // Distinct from a wrong token: the server's pre-load probe treats an
            // empty reply as a stale plugin instance and re-provisions, which
            // is the wrong answer to "ask again in a second".
            context.sendErrorReply(QStringLiteral("org.synara.ComputerUse.Error.Throttled"),
                                   QStringLiteral("A failed authentication from this connection is less than %1 ms old; retry after the cooldown.")
                                       .arg(ComputerUseAuthLimiter::cooldownMs));
            return {};
        }
        if (!verify(peer, token)) {
            limiter.noteFailure(key, now);
            return {};
        }
        limiter.noteSuccess(key);
        caller = peer;
        return instance;
    }
    bool permits(const QDBusContext &context) const
    {
        if (!context.calledFromDBus()) return true; // Internal compositor cleanup.
        if (!caller.isEmpty() && caller == context.message().service()) return true;
        context.sendErrorReply(QStringLiteral("org.synara.ComputerUse.Error.Unauthorized"), QStringLiteral("Authenticate the Synara server connection before desktop access."));
        return false;
    }
private:
    static QString lookupOwner()
    {
        auto *bus = QDBusConnection::sessionBus().interface();
        return bus ? bus->serviceOwner(QStringLiteral("org.synara.ComputerUse.Server")).value() : QString();
    }
    bool verify(const QString &peer, const QString &token)
    {
        if (peer.isEmpty() || token.size() != 64) return false;
        // Tracked from the watcher; looked up only if the bus could not be
        // asked when the plugin loaded, and then at most once per throttled
        // attempt.
        if (ownerUniqueName.isEmpty()) ownerUniqueName = lookupOwner();
        if (peer != ownerUniqueName) return false;
        if (busId.isEmpty()) {
            auto *bus = QDBusConnection::sessionBus().interface();
            QDBusReply<QString> id = bus ? bus->call(QStringLiteral("GetId")) : QDBusReply<QString>();
            if (!id.isValid()) return false;
            busId = id.value();
        }
        const QString path = QStringLiteral("/tmp/synara-computer-use-%1-%2.token").arg(getuid()).arg(busId);
        struct stat info;
        const QByteArray encodedPath = QFile::encodeName(path);
        if (lstat(encodedPath.constData(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0600) return false;
        QFile file(path);
        return file.open(QIODevice::ReadOnly) && file.read(65) == token.toUtf8();
    }
};
