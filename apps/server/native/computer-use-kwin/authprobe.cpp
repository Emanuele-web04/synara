// A private-bus authentication fixture. It never connects to a compositor.
#include "computeruseauth.h"
#include <QCoreApplication>
#include <QTextStream>

class AuthProbe : public QObject, public QDBusContext {
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "org.synara.ComputerUse1")
    ComputerUseAuth auth;
public:
    Q_INVOKABLE QString authenticate(const QString &token) { return auth.authenticate(*this, token); }
    Q_INVOKABLE QString stateJson() {
        if (!auth.permits(*this)) return {};
        return QStringLiteral("authorized");
    }
};
int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    AuthProbe probe;
    auto bus = QDBusConnection::sessionBus();
    if (!bus.registerService(QStringLiteral("org.synara.ComputerUse")) ||
        !bus.registerObject(QStringLiteral("/org/synara/ComputerUse"), &probe, QDBusConnection::ExportAllInvokables)) return 1;
    QTextStream(stdout) << "ready\n" << Qt::flush;
    return app.exec();
}
#include "authprobe.moc"
