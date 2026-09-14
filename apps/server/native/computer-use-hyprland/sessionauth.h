#pragma once
#include <sdbus-c++/sdbus-c++.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <functional>
#include <random>
#include <string>

class SynaraSessionAuth {
    sdbus::IObject& object;
    std::unique_ptr<sdbus::IProxy> daemon;
    std::string caller;
    std::string instance;
    static constexpr const char* ownerName = "org.synara.ComputerUse.Server";
public:
    SynaraSessionAuth(sdbus::IConnection& connection, sdbus::IObject& exported, std::function<void()> revoked)
        : object(exported), daemon(sdbus::createProxy(connection, sdbus::ServiceName{"org.freedesktop.DBus"}, sdbus::ObjectPath{"/org/freedesktop/DBus"})) {
        std::random_device random;
        for (int i = 0; i < 32; ++i) instance += "0123456789abcdef"[random() & 15];
        daemon->uponSignal("NameOwnerChanged").onInterface("org.freedesktop.DBus").call(
            [this, revoked](const std::string& name, const std::string& previous, const std::string&) {
                if (name == ownerName && !caller.empty() && previous == caller) { caller.clear(); revoked(); }
            });
    }
    std::string authenticate(const std::string& token) {
        if (token.size() != 64) return {};
        std::string owner, busId;
        try { daemon->callMethod("GetNameOwner").onInterface("org.freedesktop.DBus").withArguments(std::string(ownerName)).storeResultsTo(owner); }
        catch (const sdbus::Error&) { return {}; }
        const std::string sender = object.getCurrentlyProcessedMessage().getSender();
        if (owner != sender) return {};
        daemon->callMethod("GetId").onInterface("org.freedesktop.DBus").storeResultsTo(busId);
        if (busId.empty() || busId.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) return {};
        const std::string path = "/tmp/synara-computer-use-" + std::to_string(getuid()) + "-" + busId + ".token";
        const int fd = open(path.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        if (fd < 0) return {};
        struct stat info{};
        char bytes[65];
        const bool safe = fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == getuid() && (info.st_mode & 0777) == 0600;
        const ssize_t count = safe ? read(fd, bytes, sizeof(bytes)) : -1;
        close(fd);
        if (count != 64 || std::string(bytes, 64) != token) return {};
        caller = sender;
        return instance;
    }
    void require() const {
        if (caller.empty() || caller != object.getCurrentlyProcessedMessage().getSender())
            throw sdbus::Error(sdbus::Error::Name{"org.synara.ComputerUse.Error.Unauthorized"}, "Authenticate the Synara server connection before desktop access.");
    }
};
