import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'DF Festas - Espaço completo com piscina',
  description: 'Piscina, churrasqueira, pula-pula, som, Wi-Fi, área coberta e descoberta. Tudo pronto para aniversários, confraternizações e eventos em Rio de Janeiro – RJ.',
  keywords: 'festa, piscina, churrasqueira, Rio de Janeiro, eventos, aniversário',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className={inter.className}>{children}</body>
    </html>
  )
}