#include <libproc.h>
#include <sys/proc_info.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
int main(int argc,char**argv){
 if(argc!=3)return 2;
 int child=atoi(argv[1]),parent=atoi(argv[2]);
 struct proc_fdinfo fds[8192];
 int length=proc_pidinfo(parent,PROC_PIDLISTFDS,0,fds,sizeof(fds));
 printf("{\"parentFdListAvailable\":%s,\"stdio\":[",length>=0?"true":"false");
 for(int fd=0;fd<3;fd++){
  struct pipe_fdinfo p;
  int n=proc_pidfdinfo(child,fd,PROC_PIDFDPIPEINFO,&p,sizeof(p));
  if(fd)printf(",");
  printf("{\"fd\":%d,\"pipeInfoAvailable\":%s",fd,n==sizeof(p)?"true":"false");
  if(n==sizeof(p)){
   printf(",\"reportedSize\":%lld,\"openFlags\":%u,\"status\":%u,\"parentPeer\":[",p.pipeinfo.pipe_stat.vst_size,p.pfi.fi_openflags,p.pfi.fi_status);
   int found=0;
   for(int i=0;i<length/(int)sizeof(fds[0]);i++){
    if(fds[i].proc_fdtype!=PROX_FDTYPE_PIPE)continue;
    struct pipe_fdinfo q;
    if(proc_pidfdinfo(parent,fds[i].proc_fd,PROC_PIDFDPIPEINFO,&q,sizeof(q))!=sizeof(q))continue;
    if(q.pipeinfo.pipe_handle!=p.pipeinfo.pipe_peerhandle)continue;
    if(found++)printf(",");
    printf("{\"fd\":%d,\"reportedSize\":%lld,\"openFlags\":%u,\"status\":%u}",fds[i].proc_fd,q.pipeinfo.pipe_stat.vst_size,q.pfi.fi_openflags,q.pfi.fi_status);
   }
   printf("]");
  }else printf(",\"errorNumber\":%d",errno);
  printf("}");
 }
 printf("]}\n");return 0;
}
