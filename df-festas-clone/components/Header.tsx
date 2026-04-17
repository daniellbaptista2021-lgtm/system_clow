'use client'

import { useState } from 'react'
import { Menu, X } from 'lucide-react'

export default function Header() {
  const [isMenuOpen, setIsMenuOpen] = useState(false)

  return (
    <header className="bg-white shadow-sm fixed w-full top-0 z-50">
      <div className="container mx-auto px-4">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <h1 className="text-2xl font-bold text-blue-600">DF Festas</h1>
          </div>
          
          <nav className="hidden md:flex space-x-8">
            <a href="#sobre" className="text-gray-700 hover:text-blue-600 transition-colors">Sobre</a>
            <a href="#estrutura" className="text-gray-700 hover:text-blue-600 transition-colors">Estrutura</a>
            <a href="#galeria" className="text-gray-700 hover:text-blue-600 transition-colors">Galeria</a>
            <a href="#agenda" className="text-gray-700 hover:text-blue-600 transition-colors">Agenda</a>
            <a href="#contato" className="text-gray-700 hover:text-blue-600 transition-colors">Contato</a>
          </nav>

          <div className="hidden md:flex items-center space-x-4">
            <a href="#agenda" className="btn-primary">Ver agenda</a>
            <a href="https://wa.me/5521999999999" className="btn-secondary">WhatsApp</a>
          </div>

          <button 
            className="md:hidden"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
          >
            {isMenuOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
        </div>

        {isMenuOpen && (
          <div className="md:hidden">
            <div className="px-2 pt-2 pb-3 space-y-1 sm:px-3 bg-white border-t">
              <a href="#sobre" className="block px-3 py-2 text-gray-700">Sobre</a>
              <a href="#estrutura" className="block px-3 py-2 text-gray-700">Estrutura</a>
              <a href="#galeria" className="block px-3 py-2 text-gray-700">Galeria</a>
              <a href="#agenda" className="block px-3 py-2 text-gray-700">Agenda</a>
              <a href="#contato" className="block px-3 py-2 text-gray-700">Contato</a>
              <div className="px-3 py-2 space-y-2">
                <a href="#agenda" className="block btn-primary text-center">Ver agenda</a>
                <a href="https://wa.me/5521999999999" className="block btn-secondary text-center">WhatsApp</a>
              </div>
            </div>
          </div>
        )}
      </div>
    </header>
  )
}