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

/* Own network worker. Identity only on stdin; SDK binaries are provisioned separately. */
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

/* Linux ARM EABI syscall numbers. This worker intentionally permits only
 * IPv4/IPv6 sockets; Unix logging/netd sockets and filesystem writes fail. */
static int install_connect_guard(void) {
#if !defined(__arm__)
#error Only the proved ARM32 Bionic target is admitted by this draft
#endif
 const unsigned int denied[]={2,190,11,387,435,425,426,427,102,288,437,
  8,92,93,193,194,10,328,38,329,382,39,323,40,9,330,83,331,
  15,94,333,452,182,95,16,212,207,198,325,226,227,228,235,236,237,14,324,30,269,326,348,412};
 struct filter_insn code[160];unsigned int count=0;
#define EMIT(op,jt,jf,value) do{struct filter_insn entry={op,jt,jf,value};code[count++]=entry;}while(0)
#define DENY(number) do{EMIT(0x15,0,1,number);EMIT(0x06,0,0,0x00050001U);}while(0)
 EMIT(0x20,0,0,4);EMIT(0x15,1,0,AUDIT_ARCH);EMIT(0x06,0,0,0x80000000U);EMIT(0x20,0,0,0);
 for(unsigned int index=0;index<sizeof(denied)/sizeof(denied[0]);index++)DENY(denied[index]);
 /* socket(AF_INET/AF_INET6) only; AF_UNIX cannot export SDK logs. */
 EMIT(0x15,0,5,281);EMIT(0x20,0,0,16);EMIT(0x15,2,0,2);EMIT(0x15,1,0,10);EMIT(0x06,0,0,0x00050001U);EMIT(0x06,0,0,0x7fff0000U);
 /* open flags are arg1; openat flags are arg2. No writable regular files,
  * including read-only|truncate and O_TMPFILE. Read-only dlopen is allowed. */
 EMIT(0x15,0,4,5);EMIT(0x20,0,0,24);EMIT(0x45,0,1,0x00400643U);EMIT(0x06,0,0,0x00050001U);EMIT(0x06,0,0,0x7fff0000U);
 EMIT(0x15,0,4,322);EMIT(0x20,0,0,32);EMIT(0x45,0,1,0x00400643U);EMIT(0x06,0,0,0x00050001U);EMIT(0x06,0,0,0x7fff0000U);
 EMIT(0x15,0,4,120);EMIT(0x20,0,0,16);EMIT(0x45,1,0,0x00010000U);EMIT(0x06,0,0,0x00050001U);EMIT(0x06,0,0,0x7fff0000U);
 EMIT(0x06,0,0,0x7fff0000U);
 struct filter_program program={(unsigned short)count,code};
 if(count>sizeof(code)/sizeof(code[0]))return -1;
 if(prctl(38,1,0,0,0)!=0)return -1;
 return prctl(22,2,&program,0,0);
#undef DENY
#undef EMIT
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

/* Exact C facade inputs are restored from ARM32+ARM64 JNI/disassembly; no
 * public UGAgent header exists. All SDK strings are treated as confidential. */
extern int read(int,void*,unsigned int);
extern int write(int,const void*,unsigned int);
extern int dup(int);
extern int dup2(int,int);
extern int close(int);
extern int open(const char*,int,...);
extern unsigned int getuid(void);
extern int getpid(void);
extern int getppid(void);
extern void _exit(int) __attribute__((noreturn));
extern unsigned int strnlen(const char*,unsigned int);
extern int snprintf(char*,unsigned int,const char*,...);
extern void *malloc(unsigned int);
extern void free(void*);
extern int memcmp(const void*,const void*,unsigned int);
extern void *memchr(const void*,int,unsigned int);
extern int inet_pton(int,const char*,void*);
extern long syscall(long,...);
extern int getsockopt(int,int,int,void*,unsigned int*);
extern int getsockname(int,void*,unsigned int*);
struct library_address { const char *name; void *base; const char *symbol; void *address; };
extern int dladdr(const void*,struct library_address*);
#include "worker-got.h"
struct poll_item { int fd; short events,revents; };
extern int poll(struct poll_item*,unsigned int,int);
static int protocol_fd=-1;
static int closing=0,selected_port=0,last_event=-999,last_event_type=-999,last_event_port=-999;
static void erase(void *memory,unsigned int size){volatile unsigned char *p=memory;while(size--)*p++=0;}
static void emit(int event,int stage,int code,int proxy,int type,int port){
 if(protocol_fd<0)return;
 char line[256];int length=snprintf(line,sizeof(line),"{\"v\":1,\"event\":%d,\"stage\":%d,\"code\":%d,\"proxy\":%d,\"type\":%d,\"port\":%d}\n",event,stage,code,proxy,type,port);
 if(length<=0||length>=(int)sizeof(line))_exit(90);
 int result;do{result=write(protocol_fd,line,(unsigned int)length);}while(result<0&&*__errno()==4);
 if(result!=length)_exit(91); /* each frame fits PIPE_BUF; never interleave fragments */
}
static int loopback(const unsigned char *address,unsigned int size){
 if(size>=16&&address[0]==2&&address[1]==0)return address[4]==127&&address[5]==0&&address[6]==0&&address[7]==1;
 if(size>=28&&address[0]==10&&address[1]==0){for(unsigned int i=8;i<23;i++)if(address[i])return 0;return address[23]==1;}
 return 0;
}
/* Never rewrite bind addresses: outbound TCP/UDP needs wildcard local binds.
 * listen() is the exposure boundary and rejects non-loopback servers. PLT is
 * checked read-only before initialization; /proc ownership is checked by JS. */
int bind(int descriptor,const void *address,unsigned int size){
 return(int)syscall(282,descriptor,address,size);
}
int listen(int descriptor,int backlog){
 unsigned char address[128];unsigned int size=sizeof(address);
 if(getsockname(descriptor,address,&size)!=0||!loopback(address,size)){*__errno()=13;emit(-100,0,31,0,0,0);return -1;}
 return(int)syscall(284,descriptor,backlog);
}
static int own_plt(void *library,const char *anchor,unsigned int bind_slot,unsigned int listen_slot){
 struct library_address info;void *symbol=dlsym(library,anchor);if(!symbol||!dladdr(symbol,&info)||!info.base)return 0;
 unsigned char *base=info.base;
 if(bind_slot&&*(void**)(base+bind_slot)!=(void*)bind)return 0;
 if(listen_slot&&*(void**)(base+listen_slot)!=(void*)listen)return 0;
 return 1;
}


static int owned_listener(int port){
 for(int descriptor=3;descriptor<1024;descriptor++){
  int accepts=0;unsigned int length=sizeof(accepts);unsigned char address[128];unsigned int size=sizeof(address);
  if(getsockopt(descriptor,1,30,&accepts,&length)!=0||!accepts||getsockname(descriptor,address,&size)!=0)continue;
  if(size>=4&&((int)address[2]*256+address[3])==port&&loopback(address,size))return 1;
 }
 return 0;
}
static int exact(void *memory,unsigned int size){unsigned char *p=memory;while(size){int n=read(0,p,size);if(n<0&&*__errno()==4)continue;if(n<=0)return -1;p+=n;size-=(unsigned int)n;}return 0;}
static unsigned int little(const unsigned char *p){return(unsigned int)p[0]|(unsigned int)p[1]<<8|(unsigned int)p[2]<<16|(unsigned int)p[3]<<24;}
static int ws(char c){return c==' '||c=='\t'||c=='\r'||c=='\n';}
static const char *string_end(const char *p,const char *end){if(p>=end||*p++!='"')return 0;while(p<end){if(*p=='\\'){p++;if(p>=end)return 0;p++;}else if(*p++=='"')return p;}return 0;}
static const char *skip_value(const char *p,const char *end){
 while(p<end&&ws(*p))p++;if(p>=end)return 0;
 if(*p=='"')return string_end(p,end);
 if(*p=='{'||*p=='['){int depth=0;while(p<end){if(*p=='"'){p=string_end(p,end);if(!p)return 0;continue;}if(*p=='{'||*p=='[')depth++;else if(*p=='}'||*p==']'){depth--;if(!depth)return p+1;}p++;}return 0;}
 while(p<end&&*p!=','&&*p!='}')p++;return p;
}
static int number_field(const char *json,unsigned int size,const char *key,int *out){
 const char *p=json,*end=json+size;while(p<end&&ws(*p))p++;if(p>=end||*p++!='{')return -1;
 unsigned int keysize=0;while(key[keysize])keysize++;
 while(p<end){while(p<end&&ws(*p))p++;if(p<end&&*p=='}')return 0;
  const char *next=string_end(p,end);if(!next)return -1;
  int matched=(unsigned int)(next-p)==keysize+2&&memcmp(p+1,key,keysize)==0;
  p=next;while(p<end&&ws(*p))p++;if(p>=end||*p++!=':')return -1;while(p<end&&ws(*p))p++;
  if(matched){int quoted=p<end&&*p=='"';if(quoted)p++;int negative=0;if(p<end&&*p=='-'){negative=1;p++;}if(p>=end||*p<'0'||*p>'9')return -1;unsigned long value=0;
   while(p<end&&*p>='0'&&*p<='9'){value=value*10UL+(unsigned long)(*p++-'0');if(value>2147483647UL)return -1;}
   if(quoted){if(p>=end||*p++!='"')return -1;}
   while(p<end&&ws(*p))p++;if(p<end&&*p!=','&&*p!='}')return -1;*out=negative?-(int)value:(int)value;return 1;}
  p=skip_value(p,end);if(!p)return -1;while(p<end&&ws(*p))p++;if(p<end&&*p==','){p++;continue;}if(p<end&&*p=='}')return 0;return -1;
 }return -1;
}
static void sdk_event(int proxy,int event,const char *payload){
 if(__atomic_load_n(&closing,__ATOMIC_ACQUIRE))return;
 int type=0,port=0;
 if(event==6){unsigned int size=payload?strnlen(payload,4097):0;
  if(!size||size>4096||number_field(payload,size,"type",&type)!=1||number_field(payload,size,"port",&port)<0){emit(-100,0,21,proxy,0,0);return;}
  if(type!=0&&type!=2&&type!=4&&type!=5){emit(-100,0,22,proxy,0,0);return;}
  if((type==4||type==5)&&(port<1||port>65535)){emit(-100,0,23,proxy,0,0);return;}
  if(port<0||port>65535)port=0;
  __atomic_store_n(&selected_port,(type==4||type==5)?port:0,__ATOMIC_RELEASE);
 }
 if(event==0||event==6||event==7||event==-1||event==-2){if(__atomic_load_n(&last_event,__ATOMIC_ACQUIRE)!=event||__atomic_load_n(&last_event_type,__ATOMIC_ACQUIRE)!=type||__atomic_load_n(&last_event_port,__ATOMIC_ACQUIRE)!=port){__atomic_store_n(&last_event,event,__ATOMIC_RELEASE);__atomic_store_n(&last_event_type,type,__ATOMIC_RELEASE);__atomic_store_n(&last_event_port,port,__ATOMIC_RELEASE);emit(event,0,0,proxy,type,port);}}
}
/* SDK imports these liblog entry points. Suppress them before loading it.
 * AF_UNIX is denied as an independent boundary against logd/netd sockets. */
int __android_log_print(int priority,const char *tag,const char *format,...){(void)priority;(void)tag;(void)format;return 0;}
int __android_log_write(int priority,const char *tag,const char *message){(void)priority;(void)tag;(void)message;return 0;}
enum { CF_BIONIC_RTLD_NOW=0, CF_BIONIC_RTLD_GLOBAL=2 };
static int configure_dns(char *text,unsigned int size,int *setter_result){
 const char *servers[3];unsigned int count=0;char *begin=text;unsigned char address[16];
 for(unsigned int i=0;i<=size;i++)if(i==size||text[i]=='\n'){
  text[i]=0;if(!*begin||count>=3)return -41;
  if(inet_pton(2,begin,address)!=1&&inet_pton(10,begin,address)!=1)return -41;
  servers[count++]=begin;begin=text+i+1;
 }
 void *libc_handle=dlopen("./libc.so",CF_BIONIC_RTLD_NOW);if(!libc_handle)return -42;
 int(*set_servers)(unsigned int,const char**,unsigned int,const char*,const void*)=(int(*)(unsigned int,const char**,unsigned int,const char*,const void*))dlsym(libc_handle,"_resolv_set_nameservers_for_net");
 if(!set_servers||!count)return -43;
 *setter_result=set_servers(0,servers,count,"",0);return *setter_result==0?(int)count:-44;
}
static int probe_main(int argc,char **argv,char **envp){
 (void)argc;(void)argv;(void)envp;
 protocol_fd=dup(1);if(protocol_fd<3)return 2;
 int sink=open("/dev/null",1);if(sink<0||dup2(sink,1)<0||dup2(sink,2)<0)return 2;if(sink!=protocol_fd&&sink>2)close(sink);
 if(tighten_limit(0,3600)||tighten_limit(9,268435456UL)||tighten_limit(4,0)||tighten_limit(1,0)){emit(-100,0,1,0,0,0);return 3;}
 unsigned char header[28];if(exact(header,sizeof(header))||memcmp(header,"CFUGW002",8)){emit(-100,0,2,0,0,0);return 3;}
 unsigned int parent=little(header+8),owner=little(header+12),init_size=little(header+16),start_size=little(header+20),dns_size=little(header+24);
 if(owner==0||owner>2147483647U||getuid()!=owner||parent!=(unsigned int)getppid()||parent<2||!init_size||init_size>8192||!start_size||start_size>24576||!dns_size||dns_size>255){emit(-100,0,3,0,0,0);return 3;}
 if(prctl(1,9,0,0,0)!=0||(unsigned int)getppid()!=parent){emit(-100,0,4,0,0,0);return 3;}
 char *init=malloc(init_size+1),*start=malloc(start_size+1),dns[256];if(!init||!start){emit(-100,0,5,0,0,0);return 3;}
 if(exact(init,init_size)||exact(start,start_size)||exact(dns,dns_size)||memchr(init,0,init_size)||memchr(start,0,start_size)||memchr(dns,0,dns_size)){emit(-100,0,6,0,0,0);return 3;}
 init[init_size]=0;start[start_size]=0;dns[dns_size]=0;
 if(init[0]!='{'||init[init_size-1]!='}'||start[0]!='{'||start[start_size-1]!='}'){erase(start,start_size);emit(-100,0,7,0,0,0);return 3;}
 if(install_connect_guard()!=0||socket(1,1,0)!=-1||*__errno()!=1||open("./sdk-log-must-not-exist",65,0600)!=-1||*__errno()!=1){erase(start,start_size);emit(-100,0,8,0,0,0);return 3;}
 emit(100,0,0,getpid(),(int)getuid(),0);
 int setter_result=0;int dns_count=configure_dns(dns,dns_size,&setter_result);erase(dns,sizeof(dns));if(dns_count<1){erase(start,start_size);emit(-100,1,-dns_count,0,setter_result,0);return 3;}emit(100,1,dns_count,0,0,0);
 void *library=dlopen("./libugagentsdk.so",CF_BIONIC_RTLD_NOW|CF_BIONIC_RTLD_GLOBAL);if(!library){erase(start,start_size);emit(-100,0,10,0,0,0);return 4;}
 void *pg_library=dlopen("./libpgJniTunnel.so",CF_BIONIC_RTLD_NOW|CF_BIONIC_RTLD_GLOBAL);
 if(!pg_library||!own_plt(library,"sdk_init",UG_BIND_SLOT,UG_LISTEN_SLOT)||!own_plt(pg_library,"pgTunnelStart",PG_BIND_SLOT,PG_LISTEN_SLOT)){erase(start,start_size);emit(-100,0,13,0,0,0);return 4;}
 emit(100,6,0,0,0,0);
 int(*initialize)(const char*)=(int(*)(const char*))dlsym(library,"sdk_init");
 int(*start_agent)(const char*)=(int(*)(const char*))dlsym(library,"sdk_start_agent");
 int(*stop_agent)(int)=(int(*)(int))dlsym(library,"sdk_stop_agent");
 void(*release)(void)=(void(*)(void))dlsym(library,"sdk_release");
 void(*register_event)(void(*)(int,int,const char*))=(void(*)(void(*)(int,int,const char*)))dlsym(library,"sdk_register_agent_event_callback");
 int(*agent_port)(int)=(int(*)(int))dlsym(library,"sdk_get_agent_port");
 int(*link_type)(int)=(int(*)(int))dlsym(library,"sdk_get_link_type");
 if(!initialize||!start_agent||!stop_agent||!release||!register_event||!agent_port||!link_type){erase(start,start_size);emit(-100,0,11,0,0,0);return 4;}
 int result=initialize(init);erase(init,init_size);free(init);emit(100,2,result,0,0,0);
 if(result<0){erase(start,start_size);free(start);release();emit(100,5,0,0,0,0);_exit(6);}
 register_event(sdk_event);
 int handle=start_agent(start);erase(start,start_size);free(start);int proxy_port=handle>0?agent_port(handle):0;if(proxy_port<1||proxy_port>65535)proxy_port=0;emit(100,3,handle,handle,0,proxy_port);
 int previous_type=-1,previous_port=-1,previous_owned=-1;
 if(handle>0){struct poll_item input={0,1,0};for(int elapsed=0;elapsed<21600000;elapsed+=100){
   if((unsigned int)getppid()!=parent)break;
   int observed=link_type(handle);if(observed>=0&&observed<=16&&observed!=previous_type){emit(101,0,0,handle,observed,0);previous_type=observed;}
   int port=__atomic_load_n(&selected_port,__ATOMIC_ACQUIRE);int owned=port>0?owned_listener(port):0;if(port!=previous_port||owned!=previous_owned){emit(100,7,owned,handle,0,port);previous_port=port;previous_owned=owned;}
   int ready=poll(&input,1,100);if(ready<0&&*__errno()!=4)break;
   if(ready>0){char control;int n=read(0,&control,1);if(n<=0||control=='X')break;emit(-100,0,12,handle,0,0);break;}
  }
  __atomic_store_n(&closing,1,__ATOMIC_RELEASE);int stopped=stop_agent(handle);emit(100,4,stopped,handle,0,0);
 }
 __atomic_store_n(&closing,1,__ATOMIC_RELEASE);release();emit(100,5,0,0,0,0);
 /* release previously left3 threads momentarily visible. Do not dlclose their
  * code; the short-lived process boundary is the final cleanup mechanism. */
 _exit(handle>0?0:7);
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
