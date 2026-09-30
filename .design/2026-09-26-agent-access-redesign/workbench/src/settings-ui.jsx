import React, { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  CaretDown,
  Check,
  CheckCircle,
  CircleNotch,
  DownloadSimple,
  Folder,
  Gear,
  Key,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Sparkle,
  Trash,
  X,
  WarningCircle,
  Bell,
  Keyboard,
  Monitor,
  Moon,
  Sun,
  BookOpen,
  Clock,
} from "@phosphor-icons/react";
import {
  Button,
  Badge,
  AgentIcon,
  PageHeading,
  Empty,
  Notice,
  Modal,
  Toggle,
  Field,
  Tabs,
} from "./ui.jsx";

export const clone = (value) => JSON.parse(JSON.stringify(value));

export function ReviewScenario({ value, onChange, items, label = "状态演示" }) {
  return (
    <div className="set-review">
      <span>
        <SlidersHorizontal size={14} />
        {label}
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {items.map(([id, title]) => (
          <option key={id} value={id}>
            {title}
          </option>
        ))}
      </select>
      <small>仅改变原型</small>
    </div>
  );
}

export function Confirm({
  title,
  children,
  confirm = "确认",
  onConfirm,
  onClose,
  danger = false,
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            primary={!danger}
            className={danger ? "set-danger" : ""}
            onClick={onConfirm}
          >
            {confirm}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
