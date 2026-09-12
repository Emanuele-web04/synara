#pragma once

#include <QDBusConnection>
#include <QDBusConnectionInterface>
#include <QDBusContext>
#include <QDBusMessage>
#include <QDBusReply>
#include <QDBusServiceWatcher>
#include <QDir>
#include <QFile>
#include <QUuid>
#include <sys/stat.h>
#include <unistd.h>
#include <functional>

/** The server's private capability is bound to its exclusive bus connection. */
class ComputerUseAuth {
    const QString ownerName = QStringLiteral("org.synara.ComputerUse.Server");
    QString caller;
    QDBusServiceWatcher watcher;
    const QString instance = QUuid::createUuid().toString(QUuid::WithoutBraces);
public:
    std::function<void()> onRevoked;
    ComputerUseAuth()
        : watcher(ownerName, QDBusConnection::sessionBus(), QDBusServiceWatcher::WatchForOwnerChange)
    {
        QObject::connect(&watcher, &QDBusServiceWatcher::serviceOwnerChanged, &watcher,
            [this](const QString &, const QString &, const QString &) {
                caller.clear();
                if (onRevoked) onRevoked();
            });
    }
    QString authenticate(const QDBusContext &context, const QString &token)
    {
        if (!context.calledFromDBus() || token.size() != 64) return {};
        auto *bus = QDBusConnection::sessionBus().interface();
        if (!bus || bus->serviceOwner(ownerName).value() != context.message().service()) return {};
        QDBusReply<QString> id = bus->call(QStringLiteral("GetId"));
        if (!id.isValid()) return {};
        const QString path = QStringLiteral("/tmp/synara-computer-use-%1-%2.token").arg(getuid()).arg(id.value());
        struct stat info;
        const QByteArray encodedPath = QFile::encodeName(path);
        if (lstat(encodedPath.constData(), &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 0777) != 0600) return {};
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly) || file.read(65) != token.toUtf8()) return {};
        caller = context.message().service();
        return instance;
    }
    bool permits(const QDBusContext &context) const
    {
        if (!context.calledFromDBus()) return true; // Internal compositor cleanup.
        if (!caller.isEmpty() && caller == context.message().service()) return true;
        context.sendErrorReply(QStringLiteral("org.synara.ComputerUse.Error.Unauthorized"), QStringLiteral("Authenticate the Synara server connection before desktop access."));
        return false;
    }
};
