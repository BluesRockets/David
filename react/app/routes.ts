import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/login.tsx"),
  route("courses", "routes/courses.tsx"),
  route("classroom/:courseId", "routes/classroom.tsx"),
] satisfies RouteConfig;
