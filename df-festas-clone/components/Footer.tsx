export default function Footer() {
  return (
    <footer id="contato" className="bg-gray-900 text-white">
      <div className="container mx-auto px-4 py-12">
        <div className="grid md:grid-cols-3 gap-8">
          <div>
            <h3 className="text-2xl font-bold mb-4">DF Festas</h3>
            <p className="text-gray-300 mb-4">
              Espaço completo com piscina para suas festas e eventos em Rio de Janeiro.
            </p>
            <div className="flex space-x-4">
              <a href="https://wa.me/5521999999999" className="text-green-400 hover:text-green-300">
                WhatsApp
              </a>
              <a href="tel:+5521999999999" className="text-blue-400 hover:text-blue-300">
                Telefone
              </a>
            </div>
          </div>
          
          <div>
            <h4 className="text-lg font-semibold mb-4">Links Rápidos</h4>
            <ul className="space-y-2">
              <li><a href="#sobre" className="text-gray-300 hover:text-white">Sobre</a></li>
              <li><a href="#estrutura" className="text-gray-300 hover:text-white">Estrutura</a></li>
              <li><a href="#galeria" className="text-gray-300 hover:text-white">Galeria</a></li>
              <li><a href="#agenda" className="text-gray-300 hover:text-white">Agenda</a></li>
            </ul>
          </div>
          
          <div>
            <h4 className="text-lg font-semibold mb-4">Contato</h4>
            <div className="space-y-2 text-gray-300">
              <p>📍 Rua Basílio de Brito, Cachambi</p>
              <p>📱 (21) 99999-9999</p>
              <p>📧 contato@dffestas.com.br</p>
            </div>
          </div>
        </div>
        
        <div className="border-t border-gray-800 mt-8 pt-8 text-center text-gray-400">
          <p>&copy; 2024 DF Festas. Todos os direitos reservados.</p>
        </div>
      </div>
    </footer>
  )
}