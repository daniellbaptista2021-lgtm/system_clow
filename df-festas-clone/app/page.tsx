import Header from '@/components/Header'
import Hero from '@/components/Hero'
import About from '@/components/About'
import Features from '@/components/Features'
import VideoSection from '@/components/VideoSection'
import Gallery from '@/components/Gallery'
import Calendar from '@/components/Calendar'
import Contract from '@/components/Contract'
import HowToReserve from '@/components/HowToReserve'
import Footer from '@/components/Footer'

export default function Home() {
  return (
    <main className="min-h-screen">
      <Header />
      <Hero />
      <About />
      <Features />
      <VideoSection />
      <Gallery />
      <Calendar />
      <Contract />
      <HowToReserve />
      <Footer />
    </main>
  )
}