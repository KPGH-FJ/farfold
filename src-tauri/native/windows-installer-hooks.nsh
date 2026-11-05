; Tauri includes this file after utils.nsh and before expanding its checks.
; Replace the supported macro, rather than retaining the silent stop branch.
!macroundef CheckIfAppIsRunning

; PROCESSENTRY32W follows the installer process pointer size, not the app's.
!if ${NSIS_PTR_SIZE} = 4
  !define FARFOLD_PROCESSENTRY_SIZE 556
  !define FARFOLD_PROCESSENTRY_NAME_OFFSET 36
!else if ${NSIS_PTR_SIZE} = 8
  !define FARFOLD_PROCESSENTRY_SIZE 568
  !define FARFOLD_PROCESSENTRY_NAME_OFFSET 44
!else
  !error "Unsupported installer pointer size"
!endif

!macro CheckIfAppIsRunning executableName productName
  !define FarfoldGuardID ${__COUNTER__}
  System::Store "s"
  StrCpy $0 0 ; PROCESSENTRY32W allocation
  StrCpy $1 -1 ; snapshot handle
  StrCpy $5 0 ; 0 unknown, 1 complete nonmatching snapshot, 2 found

  ; The official plugin is read-only here. Its 1 also covers some errors, so
  ; it is only a preliminary check, never the absence certificate.
  ClearErrors
  nsis_tauri_utils::FindProcess "${executableName}"
  Pop $2
  IfErrors farfold_guard_cleanup_${FarfoldGuardID}
  StrCmp $2 0 farfold_guard_found_${FarfoldGuardID}
  StrCmp $2 1 0 farfold_guard_cleanup_${FarfoldGuardID}

  System::Alloc ${FARFOLD_PROCESSENTRY_SIZE}
  Pop $0
  StrCmp $0 0 farfold_guard_cleanup_${FarfoldGuardID}
  System::Call '*$0(i ${FARFOLD_PROCESSENTRY_SIZE})'
  System::Call 'kernel32::CreateToolhelp32Snapshot(i 2, i 0) p.r1'
  StrCmp $1 -1 farfold_guard_cleanup_${FarfoldGuardID}
  StrCmp $1 0 farfold_guard_cleanup_${FarfoldGuardID}
  StrCmp $1 error farfold_guard_cleanup_${FarfoldGuardID}

  StrCpy $2 ""
  System::Call 'kernel32::Process32FirstW(p r1, p r0) i.r2 ?e'
  Pop $3
  Goto farfold_guard_entry_${FarfoldGuardID}

  farfold_guard_next_${FarfoldGuardID}:
    StrCpy $2 ""
    System::Call 'kernel32::Process32NextW(p r1, p r0) i.r2 ?e'
    Pop $3
  farfold_guard_entry_${FarfoldGuardID}:
    StrCmp $2 1 farfold_guard_name_${FarfoldGuardID}
    StrCmp $2 0 0 farfold_guard_cleanup_${FarfoldGuardID}
    ; ERROR_NO_MORE_FILES is the sole accepted enumeration terminator.
    StrCmp $3 18 0 farfold_guard_cleanup_${FarfoldGuardID}
    StrCpy $5 1
    Goto farfold_guard_cleanup_${FarfoldGuardID}
  farfold_guard_name_${FarfoldGuardID}:
    StrCpy $4 ""
    System::Call '*$0(&v${FARFOLD_PROCESSENTRY_NAME_OFFSET}, &w260 .r4)'
    StrCmp $4 "" farfold_guard_cleanup_${FarfoldGuardID}
    ; Case-insensitive basename matching deliberately includes other users.
    StrCmp $4 "${executableName}" farfold_guard_found_${FarfoldGuardID}
    Goto farfold_guard_next_${FarfoldGuardID}

  farfold_guard_found_${FarfoldGuardID}:
    StrCpy $5 2
  farfold_guard_cleanup_${FarfoldGuardID}:
    StrCmp $1 -1 farfold_guard_free_${FarfoldGuardID}
    StrCmp $1 0 farfold_guard_free_${FarfoldGuardID}
    StrCmp $1 error farfold_guard_free_${FarfoldGuardID}
    StrCpy $2 ""
    System::Call 'kernel32::CloseHandle(p r1) i.r2'
    StrCmp $2 1 farfold_guard_free_${FarfoldGuardID}
    StrCpy $5 0
  farfold_guard_free_${FarfoldGuardID}:
    StrCmp $0 0 farfold_guard_decide_${FarfoldGuardID}
    System::Free $0
  farfold_guard_decide_${FarfoldGuardID}:
    StrCmp $5 1 farfold_guard_done_${FarfoldGuardID}
    StrCmp $5 2 farfold_guard_found_message_${FarfoldGuardID}
    ; Unknown must not be presented as proof that the app is running.
    System::Store "l"
    SetErrorLevel 3
    Abort
  farfold_guard_found_message_${FarfoldGuardID}:
    ; Preserve the official translated instruction to close the app normally.
    nsis_tauri_utils::StrReplace "$(appRunning)" "{{product_name}}" "${productName}"
    Pop $2
    DetailPrint "$2"
    Push $2
    System::Store "l"
    Pop $R1
    SetErrorLevel 2
    Abort "$R1"
  farfold_guard_done_${FarfoldGuardID}:
    System::Store "l"
  !undef FarfoldGuardID
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
!macroend
