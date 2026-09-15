!define SESSION_HOST_EXECUTABLE_FILENAME "nodeterm-session-host.exe"

!macro NT_FIND_PROCESS _FILE _RETURN
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
  !else
    nsExec::Exec `"$SYSDIR\cmd.exe" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${_FILE}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${_FILE}\""`
  !endif
  Pop ${_RETURN}
!macroend

!macro NT_KILL_APP _FORCE
  ${if} ${_FORCE} == 1
    StrCpy $R2 "/F"
  ${else}
    StrCpy $R2 ""
  ${endIf}
  !ifdef INSTALL_MODE_PER_ALL_USERS
    nsExec::Exec `"$SYSDIR\taskkill.exe" $R2 /IM "${APP_EXECUTABLE_FILENAME}"`
  !else
    nsExec::Exec `"$CmdPath" /C taskkill $R2 /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
  !endif
  Pop $R0
!macroend

# This replaces electron-builder's app-running macro so the persistent host can be stopped only
# after the user has accepted the update. Cancelling at the app-running prompt leaves it untouched.
!macro customCheckAppRunning
  ${if} ${isUpdated}
    Sleep 300
  ${endIf}

  !insertmacro NT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    ${if} ${isUpdated}
      Sleep 1000
      Goto nt_stop_app
    ${endIf}
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK nt_stop_app
    Quit

    nt_stop_app:
    DetailPrint "$(appClosing)"
    !insertmacro NT_KILL_APP 0
    Sleep 300
    StrCpy $R1 0

    nt_wait_for_app:
    IntOp $R1 $R1 + 1
    !insertmacro NT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      Sleep 1000
      !insertmacro NT_KILL_APP 1
      !insertmacro NT_FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 == 0
        DetailPrint `Waiting for "${PRODUCT_NAME}" to close.`
        Sleep 2000
        ${if} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY nt_wait_for_app
          Quit
        ${endIf}
        Goto nt_wait_for_app
      ${endIf}
    ${endIf}
  ${endIf}

  # The app has closed (or was already closed), so crossing the install boundary may now end the
  # persistent sessions. /T is load-bearing: shells and agents are descendants of this process.
  !insertmacro NT_FIND_PROCESS "${SESSION_HOST_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    DetailPrint "Stopping persistent terminal sessions for the update."
    !ifdef INSTALL_MODE_PER_ALL_USERS
      nsExec::Exec `"$SYSDIR\taskkill.exe" /T /F /IM "${SESSION_HOST_EXECUTABLE_FILENAME}"`
    !else
      nsExec::Exec `"$CmdPath" /C taskkill /T /F /IM "${SESSION_HOST_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    !endif
    Pop $R1
    Sleep 300
    !insertmacro NT_FIND_PROCESS "${SESSION_HOST_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      DetailPrint "Could not stop ${SESSION_HOST_EXECUTABLE_FILENAME}; installation aborted."
      MessageBox MB_OK|MB_ICONSTOP "nodeterm could not stop its persistent terminal sessions. The update was not installed." /SD IDOK
      SetErrorLevel 1
      Quit
    ${endIf}
  ${endIf}
!macroend
