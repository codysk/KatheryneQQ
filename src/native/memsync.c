/**
 * KatheryneQQ memsync addon — poke enable patch for QQ 3.2.35-54395.
 *
 * NodeIKernelMSFService.sendMsfRequest gates its cmd argument against two
 * static whitelists inside wrapper.node's RELRO region (see docs/poke.md:
 * "sendMsfRequest cmd:{} need add to cmd list call ulinzeng."). The poke
 * command (OidbSvcTrpcTcp.0xED3_1) is not whitelisted, so the kernel drops
 * the request silently.
 *
 * This addon lifts the gate from inside the process:
 *   1. locate wrapper.node's load base via dl_iterate_phdr;
 *   2. mprotect the whitelist page RW;
 *   3. repoint one harmless entry (QQClubComm.getNewFlag — QQ-club feature
 *      flag poller, unused by the bot) at the caller-supplied cmd string,
 *      stored in a static buffer so it outlives the call.
 *
 * After the patch sendMsfRequest accepts the new cmd. Reversible via
 * `restore`.
 */
#define _GNU_SOURCE
#define NAPI_VERSION 8
#include <node_api.h>
#include <dlfcn.h>
#include <link.h>
#include <string.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/mman.h>
#include <unistd.h>

/* Real RVAs in wrapper.node 3.2.35-54395 (see docs/poke.md). */
#define T1_ENTRY0_RVA 0x8e81538UL

static char g_cmd_buf[128];
static void *g_orig_ptr;
static uint64_t g_orig_len;
static void **g_slot_ptr;    /* address of the pointer slot we repointed */
static uint64_t *g_len_slot; /* address of the length slot */

static const char *g_probe_name;
static uintptr_t g_probe_base;

static int probe(struct dl_phdr_info *info, size_t size, void *data)
{
    (void)size;
    (void)data;
    if (g_probe_name && info->dlpi_name && strstr(info->dlpi_name, g_probe_name)) {
        g_probe_base = (uintptr_t)info->dlpi_addr;
        return 1;
    }
    return 0;
}

static uintptr_t module_base(const char *name)
{
    g_probe_name = name;
    g_probe_base = 0;
    dl_iterate_phdr(probe, NULL);
    return g_probe_base;
}

static napi_value Patch(napi_env env, napi_callback_info cbinfo)
{
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, cbinfo, &argc, argv, NULL, NULL);

    char cmd[128] = {0};
    size_t len = 0;
    if (argc >= 1) {
        napi_get_value_string_utf8(env, argv[0], cmd, sizeof(cmd) - 1, &len);
    }

    napi_value result;
    uintptr_t base = module_base("wrapper.node");
    if (!base) {
        napi_create_string_utf8(env, "wrapper.node not loaded", NAPI_AUTO_LENGTH, &result);
        return result;
    }
    long ps = sysconf(_SC_PAGESIZE);
    uintptr_t page = (base + T1_ENTRY0_RVA) & ~((uintptr_t)ps - 1);
    if (mprotect((void *)page, (size_t)ps, PROT_READ | PROT_WRITE) != 0) {
        napi_create_string_utf8(env, "mprotect failed", NAPI_AUTO_LENGTH, &result);
        return result;
    }

    void **slot = (void **)(base + T1_ENTRY0_RVA);
    uint64_t *lslot = (uint64_t *)(base + T1_ENTRY0_RVA + 8);
    if (!g_slot_ptr) { /* first patch: remember originals */
        g_orig_ptr = *slot;
        g_orig_len = *lslot;
        g_slot_ptr = slot;
        g_len_slot = lslot;
    }
    snprintf(g_cmd_buf, sizeof(g_cmd_buf), "%s", cmd);
    *slot = g_cmd_buf;
    *lslot = (uint64_t)strlen(g_cmd_buf);

    char msg[192];
    snprintf(msg, sizeof(msg), "patched: base=0x%lx slot=%p cmd=%s",
             (unsigned long)base, (void *)slot, g_cmd_buf);
    napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &result);
    return result;
}

static napi_value Restore(napi_env env, napi_callback_info cbinfo)
{
    (void)cbinfo;
    napi_value result;
    if (g_slot_ptr) {
        *g_slot_ptr = g_orig_ptr;
        *g_len_slot = g_orig_len;
        napi_create_string_utf8(env, "restored", NAPI_AUTO_LENGTH, &result);
    } else {
        napi_create_string_utf8(env, "nothing to restore", NAPI_AUTO_LENGTH, &result);
    }
    return result;
}

NAPI_MODULE_INIT()
{
    napi_value fn_patch, fn_restore;
    if (napi_create_function(env, "patch", NAPI_AUTO_LENGTH, Patch, NULL, &fn_patch) != napi_ok) return NULL;
    if (napi_create_function(env, "restore", NAPI_AUTO_LENGTH, Restore, NULL, &fn_restore) != napi_ok) return NULL;
    if (napi_set_named_property(env, exports, "patch", fn_patch) != napi_ok) return NULL;
    if (napi_set_named_property(env, exports, "restore", fn_restore) != napi_ok) return NULL;
    return exports;
}
