/** Only pane UI bookkeeping is substituted; no store/setup/Agent is constructed. */
const w=()=>window as any;
export const threads={closeArtifactPane:(key:string)=>w().__paneActions?.setOpen(false),openArtifactPane:()=>w().__paneActions?.setOpen(true),selectArtifact:()=>{},setFileDraft:()=>{},setFileComment:()=>{},clearFileDraft:()=>{}};
