/*
 * Copyright (C) 2012 The Android Open Source Project
 * Copyright (C) 2026 CloudFrame contributors
 *
 * Startup structure follows Bionic's crtbegin.c. All rights reserved.
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *  * Redistributions of source code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *  * Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

/* Offline version/symbol probe only. It never calls sdk_init/start_agent,
 * accepts no NAS credentials, and denies new network syscalls before dlopen.
 * Build against a real Bionic runtime; never link an Android SDK to glibc.
 */
typedef void (*init_fn)(void);
typedef struct { init_fn *preinit_array, *init_array, *fini_array; } structors;
extern void __libc_init(void *, void (*)(void), int (*)(int, char **, char **), const structors *) __attribute__((noreturn));
extern void *dlopen(const char *, int);
extern void *dlsym(void *, const char *);
extern const char *dlerror(void);
extern int dlclose(void *);
extern int puts(const char *);
extern int printf(const char *, ...);
extern int fflush(void *);
extern int prctl(int, ...);
extern int socket(int,int,int);
extern int *__errno(void);
struct resource_limit { unsigned long current, maximum; };
extern int getrlimit(int,struct resource_limit *);
extern int setrlimit(int,const struct resource_limit *);
struct filter_insn { unsigned short code; unsigned char jt, jf; unsigned int k; };
struct filter_program { unsigned short len; struct filter_insn *filter; };

#if defined(__arm__)
# define AUDIT_ARCH 0x40000028U
# define SYS_SOCKET 281U
# define SYS_CONNECT 283U
# define SYS_BIND 282U
# define SYS_SENDTO 290U
#elif defined(__aarch64__)
# define AUDIT_ARCH 0xc00000b7U
# define SYS_SOCKET 198U
# define SYS_CONNECT 203U
# define SYS_BIND 200U
# define SYS_SENDTO 206U
#elif defined(__x86_64__)
# define AUDIT_ARCH 0xc000003eU
# define SYS_SOCKET 41U
# define SYS_CONNECT 42U
# define SYS_BIND 49U
# define SYS_SENDTO 44U
#else
# error Unsupported architecture for offline network guard
#endif

static int deny_network(void) {
  struct filter_insn code[] = {
    {0x20,0,0,4}, {0x15,1,0,AUDIT_ARCH}, {0x06,0,0,0x80000000U},
    {0x20,0,0,0},
    {0x15,0,1,SYS_SOCKET}, {0x06,0,0,0x00050001U},
    {0x15,0,1,SYS_CONNECT}, {0x06,0,0,0x00050001U},
    {0x15,0,1,SYS_BIND}, {0x06,0,0,0x00050001U},
    {0x15,0,1,SYS_SENDTO}, {0x06,0,0,0x00050001U},
    {0x06,0,0,0x7fff0000U}
  };
  struct filter_program program = {(unsigned short)(sizeof(code)/sizeof(code[0])),code};
  if (prctl(38,1,0,0,0) != 0) return -1; /* PR_SET_NO_NEW_PRIVS */
  return prctl(22,2,&program,0,0); /* PR_SET_SECCOMP, SECCOMP_MODE_FILTER */
}

static int tighten_limit(int resource,unsigned long cap) {
  struct resource_limit old,checked;
  if (getrlimit(resource,&old) != 0) return -1;
  if (old.current < cap) cap=old.current;
  if (old.maximum < cap) cap=old.maximum;
  struct resource_limit target={cap,cap};
  if (setrlimit(resource,&target) != 0 || getrlimit(resource,&checked) != 0) return -1;
  return checked.current == cap && checked.maximum == cap ? 0 : -1;
}

static int probe_main(int argc, char **argv, char **envp) {
  (void)envp;
  if (argc != 2) { puts("Usage: p2p-native-probe PATH_TO_PRIVATE_SDK"); return 2; }
  if (tighten_limit(0,5) != 0 || tighten_limit(9,268435456UL) != 0 || tighten_limit(4,0) != 0) { puts("RESOURCE_LIMITS_UNAVAILABLE; library not loaded"); return 3; }
  puts("LIMITS_VERIFIED CPU_LE_5 AS_LE_268435456 CORE_0"); fflush(0);
  if (deny_network() != 0) { puts("NETWORK_GUARD_UNAVAILABLE; library not loaded"); return 3; }
  if (socket(2,2,0) != -1 || *__errno() != 1) { puts("NETWORK_GUARD_NOT_VERIFIED; library not loaded"); return 3; }
  puts("NETWORK_GUARD_VERIFIED SOCKET_EPERM"); fflush(0);
  void *handle = dlopen(argv[1],2); /* RTLD_NOW | RTLD_LOCAL */
  if (!handle) { printf("DLOPEN_FAILED: %s\n",dlerror()); return 4; }
  void (*version)(char *,int) = (void (*)(char *,int))dlsym(handle,"sdk_version");
  if (!version) { puts("SDK_VERSION_SYMBOL_MISSING"); dlclose(handle); return 5; }
  char value[128]; for (unsigned int i=0;i<sizeof(value);i++) value[i]=0;
  version(value,(int)sizeof(value)); value[127]=0;
  printf("SDK_VERSION_ONLY: %s\n",value);
  const char *symbols[] = {"sdk_init","sdk_start_agent","sdk_stop_agent","sdk_get_agent_port","sdk_get_link_type","sdk_register_agent_event_callback","sdk_start_agentP2P","sdk_set_token","sdk_release"};
  for (unsigned int i=0;i<sizeof(symbols)/sizeof(symbols[0]);i++) printf("SYMBOL %s %d\n",symbols[i],dlsym(handle,symbols[i])!=0);
  dlclose(handle); puts("NO_SDK_INIT_OR_NETWORK_CONNECTION_ATTEMPTED"); return 0;
}

__attribute__((noreturn,used)) static void cloudframe_start(void *raw) {
  static const structors arrays = {0,0,0};
  __libc_init(raw,0,probe_main,&arrays);
}
__attribute__((naked,noreturn,used)) void _start(void) {
#if defined(__arm__)
  __asm__ volatile("mov r0, sp\n b cloudframe_start\n");
#elif defined(__aarch64__)
  __asm__ volatile("mov x0, sp\n b cloudframe_start\n");
#elif defined(__x86_64__)
  __asm__ volatile("mov %rsp, %rdi\n andq $-16, %rsp\n jmp cloudframe_start\n");
#endif
}
