// Test-only foreign sender. It submits the exact public production request,
// waits for the parent's observation, then execs the trusted Rust test binary.
// No page, Agent, secret, environment override or persistent registration.
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <libproc.h>
#include <sys/proc_info.h>
#include <poll.h>
#include <unistd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t port;
    uint32_t code;
} Packet;
_Static_assert(sizeof(Packet) == 44, "production request size");

static void check(int valid, const char *stage) {
    if (!valid) {
        fprintf(stderr, "queued-exec-fixture:%s\n", stage);
        exit(21);
    }
}

static SecCodeRef code_for_pid(pid_t pid) {
    CFNumberRef number = CFNumberCreate(NULL, kCFNumberIntType, &pid);
    const void *keys[] = {kSecGuestAttributePid}, *values[] = {number};
    CFDictionaryRef attributes = CFDictionaryCreate(NULL, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    OSStatus status = SecCodeCopyGuestWithAttributes(NULL, attributes, 0, &code);
    CFRelease(attributes);
    CFRelease(number);
    check(status == 0 && code != NULL, "current-code");
    return code;
}

static int inspect(pid_t pid, pid_t broker) {
    struct proc_bsdinfo info = {0};
    check(proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info),
        "process-identity");
    SecCodeRef own = code_for_pid(broker), peer = code_for_pid(pid);
    SecRequirementRef requirement = NULL;
    check(SecCodeCheckValidity(own, 0, NULL) == 0 &&
        SecCodeCopyDesignatedRequirement(own, 0, &requirement) == 0,
        "broker-designated-requirement");
    OSStatus status = SecCodeCheckValidity(peer, 0, requirement);
    printf("{\"pid\":%d,\"uid\":%u,\"parent\":%u,\"seconds\":%llu,"
        "\"micros\":%llu,\"currentTrustedCodeStatus\":%d}\n", pid,
        info.pbi_uid, info.pbi_ppid, info.pbi_start_tvsec, info.pbi_start_tvusec,
        (int)status);
    CFRelease(requirement);
    CFRelease(peer);
    CFRelease(own);
    return 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && !strcmp(argv[1], "inspect")) {
        return inspect((pid_t)atoi(argv[2]), (pid_t)atoi(argv[3]));
    }
    check(argc == 5 && !strcmp(argv[1], "queue"), "arguments");
    mach_port_t service = MACH_PORT_NULL, reply = MACH_PORT_NULL;
    check(bootstrap_look_up(bootstrap_port, argv[2], &service) == KERN_SUCCESS,
        "lookup");
    check(mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &reply)
        == KERN_SUCCESS, "reply-port");
    Packet packet = {0};
    packet.header.msgh_bits = MACH_MSGH_BITS_COMPLEX |
        MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, MACH_MSG_TYPE_MAKE_SEND_ONCE);
    packet.header.msgh_size = sizeof(packet);
    packet.header.msgh_remote_port = service;
    packet.header.msgh_local_port = reply;
    packet.header.msgh_id = 17001;
    packet.code = 1; // production REQUEST, no descriptors and no fileport
    check(mach_msg(&packet.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
        sizeof(packet), 0, MACH_PORT_NULL, 2000, MACH_PORT_NULL) == KERN_SUCCESS,
        "queue-production-request");
    check(mach_port_deallocate(mach_task_self(), service) == KERN_SUCCESS,
        "release-service-send-right");
    puts("FOREIGN_QUEUED_VALID_44_BYTE_REQUEST");
    fflush(stdout);
    struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
    char command = 0;
    check(poll(&input, 1, 10000) == 1 && read(STDIN_FILENO, &command, 1) == 1 &&
        command == 'E', "parent-exec-instruction");
    char *args[] = {argv[3], "--exact", argv[4], "--ignored", "--nocapture",
        "--quiet", "--test-threads=1", NULL};
    execv(argv[3], args);
    check(0, "exec-trusted-test");
    return 22;
}
