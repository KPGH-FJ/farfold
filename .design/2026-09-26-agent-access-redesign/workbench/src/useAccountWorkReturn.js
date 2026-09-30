import { useState } from "react";

export default function useAccountWorkReturn({
  tasks,
  entry,
  onOpen,
  onRestore,
}) {
  const [returnStack, setReturnStack] = useState([]);
  const authWorkReturn = returnStack.at(-1) || null;
  const openBlockingWork = (id, agent) => {
    const task = tasks.find((item) => item.id === id);
    if (!task) return;
    const saved = {
      entry: structuredClone(entry),
      target: agent.id,
      label: agent.name,
      taskId: id,
    };
    setReturnStack((previous) => [...previous, saved]);
    onOpen(task);
  };
  const returnToAccount = () => {
    if (!authWorkReturn) return;
    onRestore(authWorkReturn);
    setReturnStack((previous) => previous.slice(0, -1));
  };
  const clearAccountReturn = () => setReturnStack([]);
  return {
    authWorkReturn,
    openBlockingWork,
    returnToAccount,
    clearAccountReturn,
  };
}
