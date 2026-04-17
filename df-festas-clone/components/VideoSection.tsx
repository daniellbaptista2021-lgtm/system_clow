export default function VideoSection() {
  return (
    <section className="section-padding bg-white">
      <div className="container mx-auto">
        <div className="text-center mb-12">
          <h2 className="text-3xl lg:text-4xl font-bold text-gray-900 mb-4">
            Tour rápido pelo DF Festas
          </h2>
          <p className="text-xl text-gray-600">
            Veja o vídeo principal do espaço, com piscina, área gourmet e estrutura completa.
          </p>
        </div>
        
        <div className="max-w-4xl mx-auto">
          <div className="relative aspect-video bg-gray-200 rounded-lg overflow-hidden shadow-lg">
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <div className="w-20 h-20 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
                  <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z"/>
                  </svg>
                </div>
                <p className="text-gray-600">Clique para assistir o tour virtual</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}