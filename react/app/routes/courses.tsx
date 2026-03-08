import { useEffect } from "react";
import { useNavigate } from "react-router";
import type { Route } from "./+types/courses";

interface Course {
  id: string;
  title: string;
  description: string;
  icon: string;
  color: string;
  gradient: string;
  plan: string[];
  difficulty: string;
  duration: string;
}

const COURSES: Course[] = [
  {
    id: "solar-system",
    title: "Explore the Solar System",
    description: "Embark on an interstellar journey to discover planets, moons, and the mysteries of our cosmic neighborhood.",
    icon: "M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z",
    color: "text-amber-600",
    gradient: "from-amber-400 to-orange-500",
    plan: ["What are the eight planets", "Inner planets vs outer planets", "Why does the Earth have seasons", "The mystery of Saturn's rings"],
    difficulty: "Beginner",
    duration: "15 min",
  },
  {
    id: "photosynthesis",
    title: "Magic of Photosynthesis",
    description: "Uncover how plants turn sunlight into food and why they are essential for life on Earth.",
    icon: "M12 3v2.25m0 13.5V21m-7.5-9H3m2.636-5.364L4.045 5.045m12.728 0-1.591 1.591M21 12h-2.25M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z",
    color: "text-emerald-600",
    gradient: "from-emerald-400 to-teal-500",
    plan: ["What is photosynthesis", "What do plants need to grow", "Why are leaves green", "Oxygen and our atmosphere"],
    difficulty: "Beginner",
    duration: "12 min",
  },
  {
    id: "water-cycle",
    title: "The Water Cycle",
    description: "Follow a water droplet on its incredible journey from ocean to cloud to rain and back again.",
    icon: "M12 21a9.004 9.004 0 0 0 8.716-6.747M12 21a9.004 9.004 0 0 1-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 0 1 7.843 4.582M12 3a8.997 8.997 0 0 0-7.843 4.582m15.686 0A11.953 11.953 0 0 1 12 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0 1 21 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0 1 12 16.5a17.92 17.92 0 0 1-8.716-2.247m0 0A8.966 8.966 0 0 1 3 12c0-1.264.26-2.467.732-3.558",
    color: "text-sky-600",
    gradient: "from-sky-400 to-blue-500",
    plan: ["Evaporation: water becomes vapor", "Condensation: clouds are born", "Precipitation: rain and snow", "How water returns to the ocean"],
    difficulty: "Beginner",
    duration: "10 min",
  },
  {
    id: "human-body",
    title: "Human Body Systems",
    description: "Explore the amazing machinery inside you - from your beating heart to your thinking brain.",
    icon: "M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z",
    color: "text-rose-600",
    gradient: "from-rose-400 to-pink-500",
    plan: ["The circulatory system", "How lungs work", "The digestive journey", "Your amazing brain"],
    difficulty: "Intermediate",
    duration: "18 min",
  },
  {
    id: "dinosaurs",
    title: "Age of Dinosaurs",
    description: "Travel back in time to meet the most incredible creatures that ever walked the Earth.",
    icon: "M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25",
    color: "text-violet-600",
    gradient: "from-violet-400 to-purple-500",
    plan: ["When did dinosaurs live", "Herbivores and carnivores", "The mighty T-Rex", "Why did dinosaurs go extinct"],
    difficulty: "Beginner",
    duration: "14 min",
  },
  {
    id: "electricity",
    title: "Understanding Electricity",
    description: "Discover the invisible force that powers our world, from lightning bolts to light bulbs.",
    icon: "m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z",
    color: "text-yellow-600",
    gradient: "from-yellow-400 to-amber-500",
    plan: ["What is electricity", "Conductors and insulators", "How circuits work", "Static electricity fun"],
    difficulty: "Intermediate",
    duration: "16 min",
  },
];

export function meta({}: Route.MetaArgs) {
  return [
    { title: "AI Smart Classroom - Courses" },
    { name: "description", content: "Choose your course" },
  ];
}

export default function Courses() {
  const navigate = useNavigate();

  useEffect(() => {
    if (sessionStorage.getItem("authed") !== "true") {
      navigate("/");
    }
  }, [navigate]);

  const username = sessionStorage.getItem("username") || "Student";

  const handleSelectCourse = (course: Course) => {
    sessionStorage.setItem("currentCourse", JSON.stringify(course));
    navigate(`/classroom/${course.id}`);
  };

  const handleLogout = () => {
    sessionStorage.clear();
    navigate("/");
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-indigo-50">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-white/70 backdrop-blur-xl border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.26 10.147a60.438 60.438 0 0 0-.491 6.347A48.62 48.62 0 0 1 12 20.904a48.62 48.62 0 0 1 8.232-4.41 60.46 60.46 0 0 0-.491-6.347m-15.482 0a50.636 50.636 0 0 0-2.658-.813A59.906 59.906 0 0 1 12 3.493a59.903 59.903 0 0 1 10.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0 1 12 13.489a50.702 50.702 0 0 1 7.74-3.342M6.75 15a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 0v-3.675A55.378 55.378 0 0 1 12 8.443m-7.007 11.55A5.981 5.981 0 0 0 6.75 15.75v-1.5" />
              </svg>
            </div>
            <span className="font-semibold text-gray-900">AI Smart Classroom</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold">
                {username[0].toUpperCase()}
              </div>
              <span className="text-sm text-gray-600 hidden sm:block">{username}</span>
            </div>
            <button
              onClick={handleLogout}
              className="text-sm text-gray-400 hover:text-gray-600 transition-colors cursor-pointer"
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-6 py-12">
        {/* Welcome Section */}
        <div className="mb-12 animate-[welcome-rise_700ms_ease_forwards]">
          <h1 className="text-4xl font-bold text-gray-900 tracking-tight">
            Welcome back, <span className="bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">{username}</span>
          </h1>
          <p className="mt-3 text-lg text-gray-500">Choose a course to start your AI-powered learning adventure.</p>
        </div>

        {/* Course Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {COURSES.map((course, index) => (
            <button
              key={course.id}
              onClick={() => handleSelectCourse(course)}
              className="group relative text-left bg-white rounded-2xl border border-gray-100 p-6 shadow-sm hover:shadow-xl hover:shadow-gray-200/50 hover:-translate-y-1 transition-all duration-300 cursor-pointer animate-[welcome-rise_700ms_ease_forwards] opacity-0"
              style={{ animationDelay: `${index * 80 + 100}ms` }}
            >
              {/* Card Gradient Accent */}
              <div className={`absolute inset-x-0 top-0 h-1 rounded-t-2xl bg-gradient-to-r ${course.gradient} opacity-0 group-hover:opacity-100 transition-opacity`} />

              {/* Icon */}
              <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${course.gradient} flex items-center justify-center mb-4 shadow-lg shadow-gray-200/50 group-hover:scale-110 transition-transform duration-300`}>
                <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={course.icon} />
                </svg>
              </div>

              {/* Meta */}
              <div className="flex items-center gap-2 mb-3">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gradient-to-r ${course.gradient} text-white`}>
                  {course.difficulty}
                </span>
                <span className="text-xs text-gray-400 flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
                  </svg>
                  {course.duration}
                </span>
              </div>

              {/* Title & Description */}
              <h3 className="text-lg font-semibold text-gray-900 mb-2 group-hover:text-indigo-600 transition-colors">
                {course.title}
              </h3>
              <p className="text-sm text-gray-500 leading-relaxed mb-4">
                {course.description}
              </p>

              {/* Topics Preview */}
              <div className="flex flex-wrap gap-1.5">
                {course.plan.slice(0, 3).map((topic, i) => (
                  <span key={i} className="inline-block px-2 py-1 rounded-lg bg-gray-50 text-xs text-gray-500 border border-gray-100">
                    {topic}
                  </span>
                ))}
                {course.plan.length > 3 && (
                  <span className="inline-block px-2 py-1 rounded-lg bg-gray-50 text-xs text-gray-400 border border-gray-100">
                    +{course.plan.length - 3} more
                  </span>
                )}
              </div>

              {/* Arrow */}
              <div className="absolute bottom-6 right-6 w-8 h-8 rounded-full bg-gray-50 flex items-center justify-center opacity-0 group-hover:opacity-100 translate-x-2 group-hover:translate-x-0 transition-all duration-300">
                <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                </svg>
              </div>
            </button>
          ))}
        </div>
      </main>
    </div>
  );
}
