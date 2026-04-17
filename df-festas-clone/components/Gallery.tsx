'use client'

import { useState } from 'react'
import Image from 'next/image'

export default function Gallery() {
  const [activeTab, setActiveTab] = useState('fotos')
  
  const photos = [
    'whatsapp-2025-11-23-192359-4d0f8456.jpg',
    'whatsapp-2025-11-23-192359-4ec30573.jpg',
    'whatsapp-2025-11-23-192359-6a1b0dfc.jpg',
    'whatsapp-2025-11-23-192359-c1f944ce.jpg',
    'whatsapp-2025-11-23-192359-f2ed7f44.jpg',
    'whatsapp-2025-11-24-101358-7526e9f7.jpg',
    'whatsapp-2025-11-24-101358-db700d9c.jpg',
    'whatsapp-2025-11-24-101359-139edd8f.jpg',
    'whatsapp-2025-11-24-101359-1aeb9616.jpg',
    'whatsapp-2025-11-24-101359-6f60f0ad.jpg',
    'whatsapp-2025-11-24-101359-99953c1b.jpg',
    'whatsapp-2025-11-24-101359-b91899da.jpg'
  ]

  return (
    <section id="galeria" className="section-padding bg-gray-50">
      <div className="container mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Fotos e vídeos do DF Festas
          </h2>
        </div>
        
        <div className="flex justify-center mb-8">
          <div className="bg-white rounded-lg p-1 shadow-sm">
            <button
              onClick={() => setActiveTab('fotos')}
              className={`px-6 py-2 rounded-md font-medium transition-colors ${
                activeTab === 'fotos' 
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-600 hover:text-blue-600'
              }`}
            >
              Fotos
            </button>
            <button
              onClick={() => setActiveTab('videos')}
              className={`px-6 py-2 rounded-md font-medium transition-colors ${
                activeTab === 'videos' 
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-600 hover:text-blue-600'
              }`}
            >
              Vídeos
            </button>
          </div>
        </div>

        {activeTab === 'fotos' && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {photos.map((photo, index) => (
              <div key={index} className="aspect-square bg-gray-200 rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-shadow">
                <div className="w-full h-full bg-gradient-to-br from-blue-100 to-green-100 flex items-center justify-center">
                  <span className="text-gray-500 text-sm">Foto {index + 1}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === 'videos' && (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((video, index) => (
              <div key={index} className="aspect-video bg-gray-200 rounded-lg overflow-hidden shadow-md hover:shadow-lg transition-shadow">
                <div className="w-full h-full bg-gradient-to-br from-blue-100 to-green-100 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-12 h-12 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-2">
                      <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M8 5v14l11-7z"/>
                      </svg>
                    </div>
                    <span className="text-gray-500 text-sm">Vídeo {index + 1}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}