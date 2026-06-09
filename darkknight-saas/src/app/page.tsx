"use client";

import { useState } from "react";
import styles from "./page.module.css";

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className={styles.dashboard}>
      {/* Sidebar */}
      <aside className={`${styles.sidebar} ${sidebarOpen ? styles.open : ""} glass-panel`}>
        <div className={styles.logo}>
          <span>🦇</span> DK Tutor
        </div>
        <nav className={styles.nav}>
          <div className={`${styles.navItem} ${styles.active}`}>
            <span>📚</span> AI Tutor Studio
          </div>
          <div className={styles.navItem}>
            <span>🎬</span> Library
          </div>
          <div className={styles.navItem}>
            <span>⚙️</span> Settings
          </div>
        </nav>
      </aside>

      {/* Main Content */}
      <main className={styles.main}>
        {/* Header */}
        <header className={styles.header}>
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            <button
              className={styles.mobileMenuBtn}
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              ☰
            </button>
            <h1 className={styles.headerTitle}>AI Tutor Studio</h1>
          </div>
          <div className={styles.credits}>
            <span>⚡ 1,250 Credits</span>
          </div>
        </header>

        {/* Studio Split View */}
        <div className={styles.studioContainer}>
          {/* Document Panel (Left) */}
          <section className={`${styles.documentPanel} glass-panel`}>
            <div className={styles.panelHeader}>
              <span>Document Context (RAG)</span>
              <button className={styles.uploadBtn}>+ Upload PDF</button>
            </div>
            <div className={styles.panelContent}>
              <h3 style={{ marginBottom: "12px", color: "white" }}>Lecture Transcript</h3>
              <p className={styles.transcriptText}>
                [00:00] Welcome to the lecture on Distributed Systems...
              </p>
              <p className={styles.transcriptText}>
                [01:15] Today we will discuss the Map-Reduce architecture and how it can be used to parallelize massive workloads across multiple worker nodes...
              </p>
              <p className={styles.transcriptText}>
                [03:40] As you can see in the diagram, the master node assigns chunks of data...
              </p>
              <div style={{ padding: "16px", background: "rgba(59, 130, 246, 0.1)", borderRadius: "8px", marginTop: "24px" }}>
                <h4 style={{ color: "var(--accent-color)", marginBottom: "8px" }}>AI Summary</h4>
                <ul style={{ listStyle: "inside", color: "var(--text-secondary)", fontSize: "14px" }}>
                  <li>Map-Reduce is for parallel processing.</li>
                  <li>Master node orchestrates worker nodes.</li>
                  <li>Reduces processing time from O(n) to O(n/k).</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Chat Panel (Right) */}
          <section className={`${styles.chatPanel} glass-panel`}>
            <div className={styles.panelHeader}>
              <span>AI Tutor Chat</span>
            </div>
            <div className={styles.panelContent} style={{ display: "flex", flexDirection: "column" }}>
              <div className={`${styles.message} ${styles.messageAi}`}>
                Hello! I have analyzed the lecture transcript and your PDF. What would you like to study today?
              </div>
              <div className={`${styles.message} ${styles.messageUser}`}>
                Can you explain how the Reduce phase works in simple terms?
              </div>
              <div className={`${styles.message} ${styles.messageAi}`}>
                Of course! Imagine you have 10 people counting coins. The "Map" phase is when each person counts their own pile. The "Reduce" phase is when they bring all their subtotals together and add them up to get the final total.
              </div>
            </div>
            <div className={styles.chatInput}>
              <input
                type="text"
                className={styles.inputField}
                placeholder="Ask your AI Tutor anything..."
              />
              <button className={styles.sendButton}>➤</button>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
